import type { Quadrant } from '../../api'

/**
 * Quadrant metadata. The displayable label is stored as an i18n key
 * (`todo:quadrant.q1` etc.) so consumers translate at render time.
 */
export const QUADRANT_CONFIG = [
  { q: 1 as Quadrant, labelKey: 'todo:quadrant.q1' as const, priority: 'P0', color: '#ff4d4f', bgBadge: 'count-badge-1' },
  { q: 2 as Quadrant, labelKey: 'todo:quadrant.q2' as const, priority: 'P1', color: '#faad14', bgBadge: 'count-badge-2' },
  { q: 3 as Quadrant, labelKey: 'todo:quadrant.q3' as const, priority: 'P2', color: '#1677ff', bgBadge: 'count-badge-3' },
  { q: 4 as Quadrant, labelKey: 'todo:quadrant.q4' as const, priority: 'P3', color: '#52c41a', bgBadge: 'count-badge-4' },
]

export type QuadrantConfigItem = typeof QUADRANT_CONFIG[number]
