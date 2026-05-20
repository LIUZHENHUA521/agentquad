import { useEffect, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import { searchTranscripts, type TranscriptFile } from '../../api'
import { AgentIcon } from '../AgentIcon'

const MIN_QUERY_LEN = 3
const DEBOUNCE_MS = 250
const PALETTE_LIMIT = 8

type Props = {
  query: string
  /** 命中 + 已绑 todo:命令面板会跳到 SessionFocus,把 query 作为 initialKeyword 透传 */
  onPickBound: (file: TranscriptFile, query: string) => void
  /** 命中 + 未绑 todo:命令面板负责弹 BindTodoModal */
  onPickUnbound: (file: TranscriptFile, query: string) => void
}

function formatStartedAt(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function TranscriptResultsGroup({ query, onPickBound, onPickUnbound }: Props) {
  const { t } = useTranslation(['palette'])
  const [items, setItems] = useState<TranscriptFile[]>([])
  // 用 epoch 防串台:每次发起请求 +1,回包时若 epoch 不匹配就丢弃,避免慢回包覆盖新结果。
  const epochRef = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_QUERY_LEN) {
      setItems([])
      return
    }
    const myEpoch = ++epochRef.current
    const handle = setTimeout(async () => {
      try {
        const r = await searchTranscripts({ q, limit: PALETTE_LIMIT })
        if (epochRef.current !== myEpoch) return
        setItems(r.items)
      } catch (err) {
        // 安静失败:搜索失败不应该弹 toast 打断本地 todo 搜索
        if (epochRef.current === myEpoch) setItems([])
        // eslint-disable-next-line no-console
        console.warn('[palette] transcript search failed:', err)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query])

  if (items.length === 0) return null
  const q = query.trim()

  return (
    <Command.Group heading={t('palette:groups.transcripts')}>
      {items.map((f) => {
        const bound = !!f.bound_todo_id
        const todoLabel = bound
          ? (f.bound_todo_title || f.bound_todo_id || '')
          : t('palette:transcript.noBoundTodo')
        const time = formatStartedAt(f.started_at)
        return (
          <Command.Item
            key={`transcript-${f.id}`}
            value={`transcript-${f.id}-${q}`}
            onSelect={() => {
              if (bound) onPickBound(f, q)
              else onPickUnbound(f, q)
            }}
          >
            <span className="cmdk-icon"><History size={14} /></span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <AgentIcon tool={f.tool} />
                <span style={{
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontSize: 13,
                  color: bound ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  fontStyle: bound ? undefined : 'italic',
                }}>{todoLabel}</span>
              </span>
              {f.snippet && (
                <span
                  style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  dangerouslySetInnerHTML={{ __html: f.snippet }}
                />
              )}
            </span>
            {!bound && <span className="cmdk-meta">{t('palette:meta.unbound')}</span>}
            {time && <span className="cmdk-meta">{time}</span>}
          </Command.Item>
        )
      })}
    </Command.Group>
  )
}
