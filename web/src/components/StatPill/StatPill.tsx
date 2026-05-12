import React from 'react'
import './StatPill.css'

export type PillVariant = 'default' | 'alert'

export interface StatPillProps {
  variant?: PillVariant
  /** Optional left-side icon: 'dot' (status), 'pulse-dot' (status with ring), 'arrow' */
  icon?: 'dot' | 'pulse-dot' | 'arrow'
  /** Color for the dot or arrow icon (CSS color or token var) */
  iconColor?: string
  /** Numeric or short-text value (rendered in mono) */
  value: React.ReactNode
  /** Plain text label after the value */
  label: string
  /** Optional tooltip content rendered on hover */
  tooltip?: React.ReactNode
  /** Click handler (e.g., jump to a related view) */
  onClick?: () => void
  /** Test hook */
  'data-testid'?: string
}

export function StatPill(props: StatPillProps) {
  const {
    variant = 'default',
    icon,
    iconColor,
    value,
    label,
    tooltip,
    onClick,
  } = props
  return (
    <div
      className={`stat-pill stat-pill-${variant}${onClick ? ' stat-pill-clickable' : ''}`}
      onClick={onClick}
      data-testid={props['data-testid']}
    >
      {icon === 'dot' && (
        <span className="stat-pill-dot" style={iconColor ? { background: iconColor } : undefined} />
      )}
      {icon === 'pulse-dot' && (
        <span className="stat-pill-dot stat-pill-dot-pulse" style={iconColor ? { background: iconColor } : undefined} />
      )}
      {icon === 'arrow' && (
        <span className="stat-pill-arrow" style={iconColor ? { color: iconColor } : undefined}>▲</span>
      )}
      <span className="stat-pill-value">{value}</span>
      <span className="stat-pill-label">{label}</span>
      {tooltip && <div className="stat-pill-tooltip">{tooltip}</div>}
    </div>
  )
}
