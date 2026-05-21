import { useEffect, useMemo, useState } from 'react'
import { Modal, Segmented, Button, Space, Typography, Alert, Tag, Spin, Empty } from 'antd'
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from './design/useAppMessages'
import {
  listAgentConfigFiles,
  readAgentConfigFile,
  writeAgentConfigFile,
  type AgentConfigTool,
  type AgentConfigFileMeta,
} from './api'

const { Text } = Typography

interface Props {
  open: boolean
  tool: AgentConfigTool
  onClose: () => void
}

interface LoadedFile {
  meta: AgentConfigFileMeta
  content: string
  // 当前编辑器里的草稿（dirty 判定基准）
  draft: string
}

export default function AgentConfigEditor({ open, tool, onClose }: Props) {
  const { t } = useTranslation(['settings'])
  const { message } = useAppMessages()
  const [files, setFiles] = useState<AgentConfigFileMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<Record<string, LoadedFile>>({})
  const [loadingList, setLoadingList] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = activeId ? loaded[activeId] : null

  useEffect(() => {
    if (!open) {
      // 关闭时丢弃所有 draft：用户得明确点开才会再编辑
      setLoaded({})
      setActiveId(null)
      setError(null)
      return
    }
    setLoadingList(true)
    setError(null)
    listAgentConfigFiles(tool)
      .then((list) => {
        setFiles(list)
        if (list.length > 0) setActiveId(list[0].id)
        else setActiveId(null)
      })
      .catch((e: any) => setError(e?.message || 'failed_to_list'))
      .finally(() => setLoadingList(false))
  }, [open, tool])

  useEffect(() => {
    if (!open || !activeId) return
    if (loaded[activeId]) return  // 已经加载过，保留草稿
    setLoadingFile(true)
    setError(null)
    readAgentConfigFile(tool, activeId)
      .then((r) => {
        setLoaded((prev) => ({
          ...prev,
          [activeId]: { meta: { ...r }, content: r.content, draft: r.content },
        }))
      })
      .catch((e: any) => setError(e?.message || 'failed_to_read'))
      .finally(() => setLoadingFile(false))
  }, [open, activeId, tool, loaded])

  const reloadCurrent = async () => {
    if (!activeId) return
    setLoadingFile(true)
    setError(null)
    try {
      const r = await readAgentConfigFile(tool, activeId)
      setLoaded((prev) => ({ ...prev, [activeId]: { meta: { ...r }, content: r.content, draft: r.content } }))
      message.success(t('settings:agentConfig.reloadedOk', { defaultValue: '已重新加载' }))
    } catch (e: any) {
      setError(e?.message || 'failed_to_read')
    } finally {
      setLoadingFile(false)
    }
  }

  const onDraftChange = (next: string) => {
    if (!activeId) return
    setLoaded((prev) => {
      const cur = prev[activeId]
      if (!cur) return prev
      return { ...prev, [activeId]: { ...cur, draft: next } }
    })
  }

  const save = async () => {
    if (!activeId || !active) return
    if (active.meta.format === 'json' && active.draft.trim()) {
      try { JSON.parse(active.draft) } catch (e: any) {
        message.error(t('settings:agentConfig.invalidJson', { defaultValue: 'JSON 语法错误：{{msg}}', msg: e.message }))
        return
      }
    }
    setSaving(true)
    try {
      const r = await writeAgentConfigFile(tool, activeId, active.draft)
      setLoaded((prev) => ({
        ...prev,
        [activeId]: { meta: { ...r }, content: r.content || active.draft, draft: active.draft },
      }))
      message.success(
        r.backup
          ? t('settings:agentConfig.savedOkWithBackup', { defaultValue: '已保存，备份：{{p}}', p: r.backup })
          : t('settings:agentConfig.savedOk', { defaultValue: '已保存' }),
      )
    } catch (e: any) {
      const detail = e?.body?.detail
      message.error(detail ? `${e.message} — ${detail}` : (e?.message || 'save_failed'))
    } finally {
      setSaving(false)
    }
  }

  const dirty = !!active && active.draft !== active.content

  const segmentedOptions = useMemo(
    () =>
      files.map((f) => ({
        value: f.id,
        label: (
          <span>
            {f.label}
            {!f.exists && <Tag style={{ marginLeft: 6 }}>{t('settings:agentConfig.notExist', { defaultValue: '不存在' })}</Tag>}
          </span>
        ),
      })),
    [files, t],
  )

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={920}
      title={t('settings:agentConfig.title', { defaultValue: '编辑 {{tool}} 配置', tool })}
      destroyOnClose
      footer={
        <Space>
          <Button onClick={onClose}>{t('settings:agentConfig.close', { defaultValue: '关闭' })}</Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={reloadCurrent}
            disabled={!activeId || loadingFile}
          >
            {t('settings:agentConfig.reload', { defaultValue: '重新加载' })}
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={saving}
            disabled={!dirty}
            onClick={save}
          >
            {t('settings:agentConfig.save', { defaultValue: '保存' })}
          </Button>
        </Space>
      }
    >
      {loadingList ? (
        <Spin />
      ) : files.length === 0 ? (
        <Empty description={t('settings:agentConfig.noFiles', { defaultValue: '此工具暂无可编辑的配置文件' })} />
      ) : (
        <div>
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t('settings:agentConfig.warningTitle', { defaultValue: '直接编辑全局配置' })}
            description={t('settings:agentConfig.warningDesc', {
              defaultValue: '保存会覆盖 ~/.{{tool}}/ 下的真实文件，写入前会自动备份为 .bak.<时间戳>。请确保格式正确。',
              tool,
            })}
          />
          <Segmented
            block
            value={activeId || undefined}
            onChange={(v) => setActiveId(String(v))}
            options={segmentedOptions}
          />
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
            {active && (
              <Space size={[6, 4]} wrap>
                <Text code copyable={{ text: active.meta.path }}>{active.meta.path}</Text>
                <Tag>{active.meta.format}</Tag>
                {active.meta.exists ? (
                  <Tag color="default">{(active.meta.size / 1024).toFixed(2)} KB</Tag>
                ) : (
                  <Tag color="warning">{t('settings:agentConfig.willCreate', { defaultValue: '保存时将新建' })}</Tag>
                )}
                {dirty && <Tag color="orange">{t('settings:agentConfig.dirty', { defaultValue: '有未保存修改' })}</Tag>}
              </Space>
            )}
          </div>
          {error && (
            <Alert type="error" style={{ marginTop: 12 }} showIcon message={error} />
          )}
          {loadingFile && !active ? (
            <div style={{ marginTop: 24, textAlign: 'center' }}><Spin /></div>
          ) : active ? (
            <textarea
              value={active.draft}
              onChange={(e) => onDraftChange(e.target.value)}
              spellCheck={false}
              wrap="off"
              style={{
                marginTop: 12,
                width: '100%',
                minHeight: 480,
                maxHeight: '60vh',
                fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                fontSize: 12,
                lineHeight: 1.55,
                padding: '10px 12px',
                border: '1px solid var(--border-subtle, #d9d9d9)',
                borderRadius: 4,
                background: 'var(--surface-2, #fafafa)',
                color: 'var(--text-primary, inherit)',
                resize: 'vertical',
                outline: 'none',
                whiteSpace: 'pre',
                overflow: 'auto',
              }}
              placeholder={
                active.meta.exists
                  ? ''
                  : (t('settings:agentConfig.emptyHint', {
                      defaultValue: '文件还不存在，保存时将新建。可以直接在此粘贴/编辑内容。',
                    }) as string)
              }
            />
          ) : null}
        </div>
      )}
    </Modal>
  )
}
