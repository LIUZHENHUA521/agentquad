import React from 'react'
import { Tooltip } from 'antd'
import type { UnreadSessionItem } from '../replyHub'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  items: UnreadSessionItem[]
  onActivate: (item: UnreadSessionItem) => void
  onOpenDashboard: () => void
}

export default function AttentionRail({ items, onActivate, onOpenDashboard }: Props) {
  const isMobile = useIsMobile()
  if (isMobile) return null
  const count = items.length
  if (count === 0) {
    return <div className="attention-rail attention-rail--empty" />
  }

  const displayCount = count > 99 ? '99+' : count
  const tooltipTitle = `未读：${count}`

  return (
    <div className="attention-rail is-alerting">
      <button
        type="button"
        className="attention-rail__count"
        onClick={onOpenDashboard}
        title={tooltipTitle}
      >
        {displayCount}
      </button>
      <div className="attention-rail__items">
        {items.slice(0, 12).map(item => {
          const initial = (item.todoTitle || '?').charAt(0)
          return (
            <Tooltip key={item.id} title={item.todoTitle} placement="right">
              <button
                type="button"
                className="attention-rail__item kind-unread"
                onClick={() => onActivate(item)}
              >
                {initial}
              </button>
            </Tooltip>
          )
        })}
        {items.length > 12 && (
          <Tooltip title="更多未读" placement="right">
            <button
              type="button"
              className="attention-rail__more"
              onClick={onOpenDashboard}
            >
              +{items.length - 12}
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
