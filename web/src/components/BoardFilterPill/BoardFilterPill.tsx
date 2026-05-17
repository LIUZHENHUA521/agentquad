import { useState, type ComponentType } from 'react'
import { Popover } from 'antd'
import { Asterisk, Check, Circle, ListFilter, type LucideProps } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDispatchStore, type BoardFilter } from '../../store/dispatchStore'

const ORDER: BoardFilter[] = ['todo', 'done', 'all']

const ICONS: Record<BoardFilter, ComponentType<LucideProps>> = {
  todo: Circle,
  done: Check,
  all: Asterisk,
}

export function BoardFilterPill() {
  const { t } = useTranslation('topbar')
  const [open, setOpen] = useState(false)
  const boardFilter = useDispatchStore((s) => s.boardFilter)
  const setBoardFilter = useDispatchStore((s) => s.setBoardFilter)

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
        const Icon = ICONS[value]
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
            <span className="topbar-filter-icon"><Icon size={13} strokeWidth={2} /></span>
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
          <span className="stat-pill-label">
            {labelFor(boardFilter)}
            <span className="topbar-filter-caret">▾</span>
          </span>
        </div>
      </span>
    </Popover>
  )
}
