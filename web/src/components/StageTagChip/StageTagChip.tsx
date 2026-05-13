import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createElement } from 'react'
import { Dropdown } from 'antd'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StageTag } from '../../api'
import { STAGE_TAGS, STAGE_TAG_META } from '../../stageTags'

export interface StageTagChipProps {
  value: StageTag | null
  onChange: (next: StageTag | null) => void
  disabled?: boolean
}

export function StageTagChip({ value, onChange, disabled }: StageTagChipProps) {
  const { t } = useTranslation(['common', 'topbar'])
  const items = [
    ...STAGE_TAGS.map(tag => {
      const meta = STAGE_TAG_META[tag]
      return { key: tag, label: createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, meta.icon(), t(meta.labelKey)) }
    }),
    { type: 'divider' as const },
    { key: '__clear__', label: t('common:clear'), disabled: value == null },
  ]

  const handleClick = ({ key, domEvent }: { key: string; domEvent: ReactMouseEvent | ReactKeyboardEvent }) => {
    domEvent.stopPropagation()
    if (key === '__clear__') onChange(null)
    else onChange(key as StageTag)
  }

  const meta = value != null ? STAGE_TAG_META[value] : null

  const trigger = meta == null
    ? (
      <button type="button" className="stage-tag-chip stage-tag-chip--empty" disabled={disabled}>
        <Plus size={12} />
        <span>{t('topbar:stage.addStage')}</span>
      </button>
    )
    : (
      <button type="button" className={`stage-tag-chip ${meta.className}`} disabled={disabled}>
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>{meta.icon()}</span>
        <span>{t(meta.labelKey)}</span>
      </button>
    )

  return (
    <Dropdown
      menu={{ items, onClick: handleClick }}
      trigger={['click']}
      disabled={disabled}
    >
      <span onClick={(e) => e.stopPropagation()}>{trigger}</span>
    </Dropdown>
  )
}
