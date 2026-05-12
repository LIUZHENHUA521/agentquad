import { App } from 'antd'

/**
 * Ergonomic re-export of AntD's App.useApp hook.
 * Returns { message, notification, modal } that respect the active theme.
 *
 * Usage:
 *   const { message } = useAppMessages()
 *   message.success('Saved')
 *
 * MUST be called inside the <App> component (which main.tsx mounts).
 */
export function useAppMessages() {
  return App.useApp()
}
