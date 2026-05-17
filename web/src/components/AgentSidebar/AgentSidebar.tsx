import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Todo, PromptTemplate, AiSession } from '../../api'
import './AgentSidebar.css'

export interface AgentSidebarProps {
  templates: PromptTemplate[]
  todos: Todo[]
  selectedAgentId: string | null      // null = 不过滤；'__no_agent__' = 选 No agent
  onSelectAgent: (id: string | null) => void
  onCreateAgent?: () => void
  onEditAgent?: (tpl: PromptTemplate) => void
}

const NO_AGENT_KEY = '__no_agent__'

interface AgentAggregate {
  /** template，null 表示 No agent 兜底分组 */
  template: PromptTemplate | null
  /** 关联的 active todos —— 用于显示 "正在干活" 列表 */
  activeTodos: Todo[]
  /** "在岗 RUNNING / PENDING / IDLE / 摸鱼中" 状态文案 + class */
  busyClass: 'is-busy' | 'is-pending' | ''
  statusLabel: string
}

function pickTopAgentSession(todos: Todo[]): AiSession | null {
  const sessions: AiSession[] = []
  for (const t of todos) {
    const arr = Array.isArray(t.aiSessions) ? t.aiSessions : (t.aiSession ? [t.aiSession] : [])
    sessions.push(...arr)
  }
  // 优先级：pending_confirm > running > idle > 其它
  const priority: Record<string, number> = {
    pending_confirm: 4, running: 3, idle: 2, done: 1, stopped: 1, failed: 1,
  }
  return sessions.sort((a, b) => (priority[b.status] || 0) - (priority[a.status] || 0))[0] || null
}

function isActiveTodo(t: Todo): boolean {
  return t.status !== 'done' && t.status !== 'missed'
}

function aggregateAgent(template: PromptTemplate | null, todos: Todo[]): AgentAggregate {
  const matched = todos.filter((t) => {
    if (!isActiveTodo(t)) return false
    const ids = Array.isArray(t.appliedTemplateIds) ? t.appliedTemplateIds : []
    if (template === null) return ids.length === 0       // No agent 分组
    return ids.includes(template.id)
  })
  const topSession = pickTopAgentSession(matched)
  let busyClass: AgentAggregate['busyClass'] = ''
  let statusLabel = template === null ? '待分配' : '摸鱼中'
  if (topSession) {
    if (topSession.status === 'pending_confirm') {
      busyClass = 'is-pending'
      statusLabel = '在岗 · PENDING'
    } else if (topSession.status === 'running') {
      busyClass = 'is-busy'
      statusLabel = '在岗 · RUNNING'
    } else if (topSession.status === 'idle') {
      busyClass = 'is-busy'
      statusLabel = '在岗 · IDLE'
    }
  }
  return { template, activeTodos: matched, busyClass, statusLabel }
}

function AgentRow({
  agg, num, selected, onClick, onDoubleClick,
}: {
  agg: AgentAggregate
  num: string
  selected: boolean
  onClick: () => void
  onDoubleClick?: () => void
}) {
  const isNoAgent = agg.template === null
  const name = isNoAgent ? 'No agent' : agg.template!.name
  const role = isNoAgent
    ? 'UNASSIGNED'
    : (agg.template!.description?.split(/[，,。.]/)[0]?.slice(0, 12).toUpperCase() || 'AGENT')
  const className = [
    'agent-row',
    selected ? 'is-selected' : '',
    agg.busyClass,
    isNoAgent ? 'is-no-agent' : '',
  ].filter(Boolean).join(' ')

  const todoTitles = agg.activeTodos.slice(0, 3)

  return (
    <div className={className} onClick={onClick} onDoubleClick={onDoubleClick}>
      <div className="agent-row-head">
        <span className="agent-row-num">{num}</span>
        <span className="agent-row-name">
          {name}<span className="role">{role}</span>
        </span>
        <span className="agent-row-load">{agg.activeTodos.length}</span>
      </div>
      <div className="agent-row-status">
        <span className="pulse" />
        {agg.statusLabel}
      </div>
      <ul className="agent-row-todos">
        {todoTitles.length === 0 ? (
          <li className="muted">— 暂无指派 —</li>
        ) : (
          todoTitles.map((t) => (
            <li key={t.id} title={t.title}>{t.title}</li>
          ))
        )}
      </ul>
    </div>
  )
}

export function AgentSidebar({
  templates, todos, selectedAgentId, onSelectAgent, onCreateAgent, onEditAgent,
}: AgentSidebarProps) {
  const { t } = useTranslation(['todo', 'settings'])

  const aggregates = useMemo<AgentAggregate[]>(() => {
    return templates.map((tpl) => aggregateAgent(tpl, todos))
  }, [templates, todos])

  const noAgent = useMemo(() => aggregateAgent(null, todos), [todos])

  const totalAgentCount = templates.length + (noAgent.activeTodos.length > 0 ? 1 : 0)

  return (
    <aside className="agent-sidebar">
      <div className="agent-sidebar-head">
        <span className="agent-sidebar-title">
          {t('todo:agentSidebar.title', { defaultValue: '员工档案 — Roster' })}
        </span>
        <span className="agent-sidebar-count">{totalAgentCount}</span>
      </div>

      <div className="agent-sidebar-list">
        {aggregates.map((agg, i) => (
          <AgentRow
            key={agg.template!.id}
            agg={agg}
            num={String(i + 1).padStart(2, '0')}
            selected={selectedAgentId === agg.template!.id}
            onClick={() => onSelectAgent(selectedAgentId === agg.template!.id ? null : agg.template!.id)}
            onDoubleClick={() => onEditAgent?.(agg.template!)}
          />
        ))}
        {/* No-agent 分组永远显示（即使为空也作为占位，方便用户感知"还有未指派的"） */}
        <AgentRow
          agg={noAgent}
          num="∅"
          selected={selectedAgentId === NO_AGENT_KEY}
          onClick={() => onSelectAgent(selectedAgentId === NO_AGENT_KEY ? null : NO_AGENT_KEY)}
        />
      </div>

      <div className="agent-sidebar-foot">
        <button className="new-agent-btn" type="button" onClick={onCreateAgent}>
          {t('todo:agentSidebar.newAgentBtn', { defaultValue: '+ 招新员工' })}
        </button>
      </div>
    </aside>
  )
}

/**
 * Public predicate：根据 sidebar 选中状态过滤 todos。
 * - null → 不过滤
 * - NO_AGENT_KEY → 只剩没绑 agent 的
 * - template id → 只剩该 agent 旗下的
 */
export function applyAgentFilter(todos: Todo[], selectedAgentId: string | null): Todo[] {
  if (selectedAgentId === null) return todos
  if (selectedAgentId === NO_AGENT_KEY) {
    return todos.filter((t) => !Array.isArray(t.appliedTemplateIds) || t.appliedTemplateIds.length === 0)
  }
  return todos.filter((t) => Array.isArray(t.appliedTemplateIds) && t.appliedTemplateIds.includes(selectedAgentId))
}

export { NO_AGENT_KEY }
