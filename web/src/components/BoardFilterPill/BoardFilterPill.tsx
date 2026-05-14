import { useState } from 'react'
import { Popover } from 'antd'
import { ListFilter } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDispatchStore, type BoardFilter } from '../../store/dispatchStore'
import { useTodoSnapshotStore } from '../../store/todoSnapshotStore'

const ORDER: BoardFilter[] = ['todo', 'done', 'all']

const ICONS: Record<BoardFilter, string> = {
  todo: '●',
  done: '✓',
  all: '∗',
}

export function BoardFilterPill() {
  const { t } = useTranslation('topbar')
  const [open, setOpen] = useState(false)
  const boardFilter = useDispatchStore((s) => s.boardFilter)
  const setBoardFilter = useDispatchStore((s) => s.setBoardFilter)
  const count = useTodoSnapshotStore((s) => s.todos.length)

  const labelFor = (f: BoardFilter): string => {
    if (f === 'done') return t('topbar:filter.labelDone')
    if (f === 'all') return t('topbar:filter.labelAll')
    return t('topbar:filter.labelTodo')
  }
  const optionFor = (f: BoardFilter): string => {
    if (f === 'done') return t('topbar:filter.optionDone')
    if (f === 'all') return t('topbar:filter.optionAll')
    return t('topbar:filter.optionTodo')
  }

  const content = (
    <div className="topbar-filter-list">
      {ORDER.map((value) => {
        const active = value === boardFilter
        return (
          <button
            key={value}
            type="button"
            className={`topbar-filter-row${active ? ' is-active' : ''}`}
            onClick={() => {
              setBoardFilter(value)
              setOpen(false)
            }}
            data-testid={`topbar-filter-option-${value}`}
          >
            <span className="topbar-filter-icon">{ICONS[value]}</span>
            <span>{optionFor(value)}</span>
          </button>
        )
      })}
    </div>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      overlayClassName="topbar-pending-popover"
      content={content}
    >
      <span data-testid="topbar-filter-trigger">
        <div
          className="stat-pill stat-pill-default stat-pill-clickable topbar-filter-pill"
          onClick={() => setOpen((v) => !v)}
          data-testid="topbar-filter-pill"
        >
          <span className="stat-pill-custom-icon" style={{ color: 'var(--accent-electric)' }}>
            <ListFilter size={13} />
          </span>
          <span className="stat-pill-value">{count}</span>
          <span className="stat-pill-label">
            {labelFor(boardFilter)}
            <span className="topbar-filter-caret">▾</span>
          </span>
        </div>
      </span>
    </Popover>
  )
}
