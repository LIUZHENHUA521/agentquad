export type BrowserNotificationPermission = NotificationPermission | 'unsupported'

/** i18n key for the "AI reply done, please review" text. */
export const TURN_DONE_TEXT_KEY = 'session:turnDone.text' as const
/** i18n key for the "Notify" button label. */
export const TURN_DONE_NOTIFICATION_BUTTON_LABEL_KEY = 'session:turnDone.buttonLabel' as const
export const TURN_DONE_NOTIFICATION_BUTTON_STYLE = {
  height: 20,
  minWidth: 34,
  paddingInline: 6,
  fontSize: 11,
  lineHeight: '18px',
}

export function getBrowserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') return 'unsupported'
  return window.Notification.permission
}

export function shouldSendTurnDoneSystemNotification({
  permission,
  documentHidden,
  windowFocused,
}: {
  permission: BrowserNotificationPermission | string
  documentHidden: boolean
  windowFocused: boolean
}): boolean {
  return permission === 'granted' && (documentHidden || !windowFocused)
}
