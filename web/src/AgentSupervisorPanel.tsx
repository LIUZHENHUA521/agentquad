import { useEffect, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { getAgentSupervisorStatus, updateAgentSupervisorConfig, listAgentDecisions, type AgentSupervisorConfig, type AgentDecisionRow } from './api'

const { Text, Paragraph } = Typography

const MODEL_OPTIONS = [
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7（默认，准确度最高）' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6（更便宜）' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5（最便宜，可能误判更多）' },
]

function statusTag(status: string) {
  switch (status) {
    case 'auto': return <Tag color="green">自动通过</Tag>
    case 'fallback': return <Tag color="orange">降级</Tag>
    case 'failed': return <Tag color="red">失败</Tag>
    case 'skipped': return <Tag>跳过</Tag>
    default: return <Tag>{status}</Tag>
  }
}

function kindLabel(k: string) {
  if (k === 'permission') return 'PTY 权限'
  if (k === 'ask_user') return 'ask_user'
  if (k === 'active_push') return '主动推进'
  return k
}

export default function AgentSupervisorPanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [config, setConfig] = useState<AgentSupervisorConfig | null>(null)
  const [decisions, setDecisions] = useState<AgentDecisionRow[]>([])
  const [total, setTotal] = useState(0)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [allowlistText, setAllowlistText] = useState('')
  const [form] = Form.useForm()

  async function refresh() {
    setLoading(true)
    try {
      const r = await getAgentSupervisorStatus()
      setConfig(r.config)
      setAllowlistText((r.config.allowlist || []).join('\n'))
      form.setFieldsValue({
        enabled: r.config.enabled,
        model: r.config.model || 'claude-opus-4-7',
        threshold: r.config.threshold ?? 0.8,
        permissionAuto: r.config.permissionAuto !== false,
        askUserAuto: r.config.askUserAuto !== false,
      })
      const list = await listAgentDecisions({ limit: 50 })
      setDecisions(list.items)
      setTotal(list.total)
    } catch (e: any) {
      message.error(`加载失败：${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  async function onSave() {
    const v = await form.validateFields()
    setSaving(true)
    try {
      const patch: any = {
        enabled: !!v.enabled,
        model: v.model,
        threshold: Number(v.threshold),
        permissionAuto: !!v.permissionAuto,
        askUserAuto: !!v.askUserAuto,
        allowlist: allowlistText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      }
      // apiKey 留空或保留 hint → 不提交（不覆盖）
      if (apiKeyInput && !apiKeyInput.includes('…')) {
        patch.apiKey = apiKeyInput
      }
      await updateAgentSupervisorConfig(patch)
      message.success('已保存')
      setApiKeyInput('')
      await refresh()
    } catch (e: any) {
      message.error(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="代决策官（Agent Supervisor）"
        description={
          <Paragraph style={{ margin: 0 }}>
            开启后，主人不在的时候，AI 会替你处理终端的"待确认"弹窗（如 Claude 的权限提示、ask_user 二选一）。
            只会选中白名单里的安全选项（如 Allow / Yes），且置信度 ≥ 阈值才会自动决策；
            其它情况自动降级回 IM / web 通知，等你来看。
            <br />
            主动推进 / 浏览器代驾在 Phase 2 / Phase 3 上线。
          </Paragraph>
        }
      />

      <Form form={form} layout="vertical" disabled={loading}>
        <Form.Item label="全局开关" name="enabled" valuePropName="checked">
          <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
        </Form.Item>

        <Form.Item label="判官模型" name="model">
          <Select options={MODEL_OPTIONS} style={{ maxWidth: 480 }} />
        </Form.Item>

        <Form.Item label={<>Anthropic API Key {config?.apiKeyHint && <Text type="secondary"> 当前：{config.apiKeyHint}</Text>}</>}>
          <Input.Password
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
            placeholder={config?.hasApiKey ? '（已配置，留空不变；填新值则覆盖）' : '粘贴 sk-ant-… 或留空使用 env ANTHROPIC_API_KEY'}
            autoComplete="off"
          />
        </Form.Item>

        <Form.Item label="置信度阈值（0-1）" name="threshold" extra="模型自报置信度 ≥ 此值才自动决策。建议 0.8。">
          <InputNumber min={0} max={1} step={0.05} style={{ width: 160 }} />
        </Form.Item>

        <Form.Item label="安全白名单（一行一个关键词，命中即视为安全选项）" extra="选项文本（小写）includes 任一关键词才允许自动选。默认只放 Allow / Yes / Continue 等无害动作。">
          <Input.TextArea
            value={allowlistText}
            onChange={(e) => setAllowlistText(e.target.value)}
            rows={5}
            placeholder={'allow\nyes\ncontinue\nproceed\napprove'}
          />
        </Form.Item>

        <Form.Item label="处理 PTY 权限弹窗（Claude 的 Read / Bash / Edit 授权框）" name="permissionAuto" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item label="处理 ask_user MCP 二选一" name="askUserAuto" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Form.Item>
          <Space>
            <Button type="primary" onClick={onSave} loading={saving}>保存</Button>
            <Button onClick={refresh} loading={loading}>刷新</Button>
          </Space>
        </Form.Item>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 24 }}>代决策时间线（最近 50 条 / 共 {total}）</Typography.Title>
      <Table<AgentDecisionRow>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={decisions}
        pagination={false}
        scroll={{ y: 360 }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 140, render: (v: number) => new Date(v).toLocaleString() },
          { title: '类型', dataIndex: 'kind', width: 100, render: (v: string) => kindLabel(v) },
          { title: '状态', dataIndex: 'status', width: 100, render: statusTag },
          { title: '选择', dataIndex: 'choice', width: 180, render: (v: string | null) => v || <Text type="secondary">—</Text> },
          { title: '置信度', dataIndex: 'confidence', width: 90, render: (v: number | null) => v != null ? v.toFixed(2) : '—' },
          { title: '理由', dataIndex: 'reason', ellipsis: true, render: (v: string | null) => v || <Text type="secondary">—</Text> },
          { title: '模型', dataIndex: 'model', width: 160, ellipsis: true, render: (v: string | null) => v || <Text type="secondary">—</Text> },
          { title: 'Token (in/out)', width: 110, render: (_: any, row: AgentDecisionRow) => row.tokensIn != null ? `${row.tokensIn}/${row.tokensOut ?? '?'}` : '—' },
          { title: '耗时', dataIndex: 'ms', width: 80, render: (v: number | null) => v != null ? `${v}ms` : '—' },
        ]}
      />
    </div>
  )
}
