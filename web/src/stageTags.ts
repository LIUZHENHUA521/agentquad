import type { ReactNode } from 'react'
import { createElement } from 'react'
import { Wrench, MessageSquare, FlaskConical, Rocket, Ban } from 'lucide-react'
import type { StageTag } from './api'

export const STAGE_TAGS: readonly StageTag[] = ['dev', 'review', 'test', 'release', 'blocked'] as const

type StageLabelKey =
  | 'topbar:stage.dev'
  | 'topbar:stage.review'
  | 'topbar:stage.test'
  | 'topbar:stage.release'
  | 'topbar:stage.blocked'

export const STAGE_TAG_META: Record<StageTag, { labelKey: StageLabelKey; icon: () => ReactNode; className: string }> = {
  dev:     { labelKey: 'topbar:stage.dev',     icon: () => createElement(Wrench, { size: 12 }),          className: 'stage-tag-dev' },
  review:  { labelKey: 'topbar:stage.review',  icon: () => createElement(MessageSquare, { size: 12 }),   className: 'stage-tag-review' },
  test:    { labelKey: 'topbar:stage.test',    icon: () => createElement(FlaskConical, { size: 12 }),     className: 'stage-tag-test' },
  release: { labelKey: 'topbar:stage.release', icon: () => createElement(Rocket, { size: 12 }),           className: 'stage-tag-release' },
  blocked: { labelKey: 'topbar:stage.blocked', icon: () => createElement(Ban, { size: 12 }),              className: 'stage-tag-blocked' },
}
