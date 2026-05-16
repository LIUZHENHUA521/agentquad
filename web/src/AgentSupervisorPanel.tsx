import { useEffect, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Select, Space, Switch, Table, Tag, Typography, message } from 'antd'
import { getAgentSupervisorStatus, updateAgentSupervisorConfig, listAgentDecisions, type AgentSupervisorConfig, type AgentDecisionRow } from './api'

const { Text, Paragraph } = Typography

const TOOL_OPTIONS = [
  { value: 'claude', label: 'Claude Code（默认，推荐）' },
  { value: 'codex', label: 'Codex（OpenAI）' },
  { value: 'cursor', label: 'Cursor Agent' },
]

// 给每个 tool 推荐的 model（空 = 用 CLI 默认；用户可手填）
const MODEL_HINTS: Record<string, string[]> = {
  claude: ['', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  codex: ['', 'gpt-5'],
  cursor: ['', 'sonnet-4', 'gpt-5'],
}

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
        tool: r.config.tool || 'claude',
        model: r.config.model || '',
        timeoutMs: r.config.timeoutMs ?? 60000,
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
        tool: v.tool,
        model: (v.model || '').trim(),
        timeoutMs: Number(v.timeoutMs),
        threshold: Number(v.threshold),
        permissionAuto: !!v.permissionAuto,
        askUserAuto: !!v.askUserAuto,
        allowlist: allowlistText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
      }
      await updateAgentSupervisorConfig(patch)
      message.success('已保存')
      await refresh()
    } catch (e: any) {
      message.error(`保存失败：${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  const currentTool = config?.tool || 'claude'
  const modelHints = MODEL_HINTS[currentTool] || ['']

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="代决策官（Agent Supervisor）"
        description={
          <Paragraph style={{ margin: 0 }}>
            开启后，主人不在的时候，会跑你已经装好并登录的 <Text code>claude</Text> / <Text code>codex</Text> / <Text code>cursor-agent</Text> CLI 做决策——
            不调 API，不烧 API 额度，所有 token 走你现有的订阅。
            <br />
            只会选中白名单里的安全选项（如 Allow / Yes），且置信度 ≥ 阈值才会自动决策；
            其它情况自动降级回 IM / web 通知，等你来看。
            <br />
            主动推进 / 浏览器代驾在 Phase 2 / Phase 3 上线。
          </Paragraph>
        }
      />

      {config?.bin ? (
        <Alert
          type={config.bin ? 'success' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message={`将执行：${config.bin}`}
        />
      ) : null}

      <Form form={form} layout="vertical" disabled={loading}>
        <Form.Item label="全局开关" name="enabled" valuePropName="checked">
          <Switch checkedChildren="已开启" unCheckedChildren="已关闭" />
        </Form.Item>

        <Form.Item label="判官工具（用哪个本地 CLI）" name="tool" extra="必须是你已经装好并登录过的 CLI（设置 → 工具 里可以管理）。">
          <Select options={TOOL_OPTIONS} style={{ maxWidth: 480 }} onChange={() => form.setFieldValue('model', '')} />
        </Form.Item>

        <Form.Item label="可选：指定 model" name="model" extra="留空 = 用 CLI 自己的默认 model。需要 pin 到特定型号时手填。">
          <Select
            allowClear
            style={{ maxWidth: 480 }}
            options={modelHints.map((m) => ({ value: m, label: m || '（默认）' }))}
            mode="tags"
            maxTagCount={1}
          />
        </Form.Item>

        <Form.Item label="单次决策超时（毫秒）" name="timeoutMs" extra="CLI 超过这个时间没出结果就放弃，降级回原流程。默认 60_000（60s）。">
          <InputNumber min={5000} max={600000} step={5000} style={{ width: 200 }} />
        </Form.Item>

        <Form.Item label="置信度阈值（0-1）" name="threshold" extra="CLI 自报置信度 ≥ 此值才自动决策。建议 0.8。">
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
          { title: '工具/模型', dataIndex: 'model', width: 160, ellipsis: true, render: (v: string | null) => v || <Text type="secondary">—</Text> },
          { title: '耗时', dataIndex: 'ms', width: 80, render: (v: number | null) => v != null ? `${v}ms` : '—' },
        ]}
      />
    </div>
  )
}
