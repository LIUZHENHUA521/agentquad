import { useEffect, useState, useCallback, useMemo } from 'react'
import { Card, Button, Tag, Space, Typography, message, Modal, Checkbox } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  listTemplatePacks,
  installTemplatePack,
  uninstallTemplatePack,
  type TemplatePack,
} from './api'

const { Text, Paragraph } = Typography

interface Props {
  onChanged?: () => void
}

export default function AgencyPackSection({ onChanged }: Props) {
  const { t } = useTranslation(['settings'])
  const [packs, setPacks] = useState<TemplatePack[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<TemplatePack | null>(null)
  const [picked, setPicked] = useState<string[]>([])

  const refresh = useCallback(async () => {
    try { setPacks(await listTemplatePacks()) } catch (e: any) {
      message.error(e?.message || 'failed to load packs')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const openPicker = (p: TemplatePack) => {
    if (!Array.isArray(p.categories)) {
      // Server is running old code without the per-category breakdown.
      // Tell the user instead of crashing on `p.categories.map(...)` below.
      message.error(t('settings:templatePacks.serverStale', {
        defaultValue: 'Server is running old code — restart with `npm run stop && npm start` to use the picker.',
      }))
      return
    }
    setPickerFor(p)
    setPicked((p.installedCategories || []).slice())
  }
  const closePicker = () => { setPickerFor(null); setPicked([]) }

  const apply = async () => {
    if (!pickerFor) return
    setBusy(pickerFor.id)
    try {
      const res = await installTemplatePack(pickerFor.id, picked)
      message.success(t('settings:templatePacks.installedOk', { n: res.installed }))
      closePicker()
      await refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || 'install failed')
    } finally { setBusy(null) }
  }

  const onUninstall = async (id: string) => {
    setBusy(id)
    try {
      await uninstallTemplatePack(id)
      message.success(t('settings:templatePacks.uninstalledOk'))
      await refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || 'uninstall failed')
    } finally { setBusy(null) }
  }

  const totalPicked = useMemo(() => {
    if (!pickerFor) return 0
    return pickerFor.categories
      .filter(c => picked.includes(c.slug))
      .reduce((sum, c) => sum + c.count, 0)
  }, [pickerFor, picked])

  if (packs.length === 0) return null

  return (
    <div style={{ marginTop: 24 }}>
      <Typography.Title level={5} style={{ marginBottom: 4 }}>
        {t('settings:templatePacks.sectionTitle')}
      </Typography.Title>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('settings:templatePacks.sectionDesc')}
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {packs.map(p => {
          const key = `settings:templatePacks.packs.${p.id}` as const
          return (
            <Card key={p.id} size="small">
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space>
                  <Text strong>{t(`${key}.name` as any, p.id)}</Text>
                  {p.installedCount > 0
                    ? <Tag color="green">{t('settings:templatePacks.installedCount', { n: p.installedCount })}</Tag>
                    : <Tag>{t('settings:templatePacks.availableCount', { n: p.entryCount })}</Tag>
                  }
                </Space>
                <Text type="secondary">{t(`${key}.desc` as any, '')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('settings:templatePacks.attribution', { src: p.attribution, license: p.license })}
                </Text>
                {p.installedCount > 0 && (
                  <Space size={4} wrap>
                    {p.installedCategories.map(slug => {
                      const cat = p.categories.find(c => c.slug === slug)
                      return (
                        <Tag key={slug}>
                          {t(`settings:template.categoryLabels.${slug}` as any, slug as string)} · {cat?.count ?? '?'}
                        </Tag>
                      )
                    })}
                  </Space>
                )}
                <div>
                  <Space>
                    <Button
                      type={p.installedCount > 0 ? 'default' : 'primary'}
                      size="small"
                      loading={busy === p.id}
                      onClick={() => openPicker(p)}
                    >
                      {p.installedCount > 0
                        ? t('settings:templatePacks.adjust', { defaultValue: '调整选择' })
                        : t('settings:templatePacks.pick', { defaultValue: '选择员工' })}
                    </Button>
                    {p.installedCount > 0 && (
                      <Button
                        danger
                        size="small"
                        loading={busy === p.id}
                        onClick={() => onUninstall(p.id)}
                      >
                        {t('settings:templatePacks.uninstallAll', { defaultValue: '全部卸载' })}
                      </Button>
                    )}
                  </Space>
                </div>
              </Space>
            </Card>
          )
        })}
      </Space>

      <Modal
        open={!!pickerFor}
        onCancel={closePicker}
        onOk={apply}
        confirmLoading={busy === pickerFor?.id}
        title={t('settings:templatePacks.pickerTitle', { defaultValue: '选择员工分类' })}
        okText={t('settings:templatePacks.apply', { defaultValue: '应用' })}
        cancelText={t('settings:templatePacks.cancel', { defaultValue: '取消' })}
        width={520}
      >
        {pickerFor && (
          <div>
            <Space style={{ marginBottom: 12 }}>
              <Button size="small" onClick={() => setPicked(pickerFor.categories.map(c => c.slug))}>
                {t('settings:templatePacks.selectAll', { defaultValue: '全选' })}
              </Button>
              <Button size="small" onClick={() => setPicked([])}>
                {t('settings:templatePacks.clearAll', { defaultValue: '清空' })}
              </Button>
            </Space>
            <Checkbox.Group
              value={picked}
              onChange={(v) => setPicked(v as string[])}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {pickerFor.categories.map(c => (
                <Checkbox key={c.slug} value={c.slug}>
                  {t(`settings:template.categoryLabels.${c.slug}` as any, c.slug)} · {c.count}
                </Checkbox>
              ))}
            </Checkbox.Group>
            <Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
              {t('settings:templatePacks.pickerSummary', {
                cats: picked.length,
                agents: totalPicked,
                defaultValue: '已选 {{cats}} 个分类 / {{agents}} 个员工',
              })}
            </Paragraph>
          </div>
        )}
      </Modal>
    </div>
  )
}
