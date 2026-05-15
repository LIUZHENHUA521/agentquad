import { useTranslation } from 'react-i18next'
import type { FocusTab } from '../../store/focusStore'

interface Props {
  value: FocusTab
  onChange: (tab: FocusTab) => void
}

export function FocusTabs({ value, onChange }: Props) {
  const { t } = useTranslation(['session'])
  const tabs: { key: FocusTab; label: string }[] = [
    { key: 'conversation', label: t('session:tabs.conversation') },
    { key: 'live', label: t('session:tabs.live') },
  ]
  return (
    <div className="focus-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          className={`focus-tab${value === tab.key ? ' active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
