import { create } from 'zustand'
import { useFocusStore } from './focusStore'

export type DrawerKey = 'settings' | 'stats' | 'wiki' | 'report' | 'statsReports'

interface DispatchState {
  // Drawer open flags (lifted from TodoManage local state)
  settings: boolean
  stats: boolean
  wiki: boolean
  report: boolean
  /** Unified flag for the merged Stats + Reports drawer (M4-T2). */
  statsReports: boolean

  // Command palette open state
  palette: boolean

  // Action: open a drawer by name
  openDrawer: (key: DrawerKey) => void
  // Action: close a drawer by name
  closeDrawer: (key: DrawerKey) => void
  // Convenience: close every drawer at once (used when opening palette)
  closeAllDrawers: () => void

  // Palette controls
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void

  /** Open the session focus overlay for the given todo (and its session, if known). Closes palette + drawers. */
  openFocus: (todoId: string, sessionId?: string | null) => void

  /** When set, TodoManage should scroll/focus this todo and clear the field */
  jumpToTodoId: string | null
  /** When true, TodoManage should open its new-todo drawer and clear the flag */
  requestNewTodo: boolean
  /** When true, TodoManage should open its transcript-recover drawer */
  requestRecover: boolean
  requestRecoverOpen: () => void
  consumeRequestRecover: () => void

  setJumpTo: (id: string | null) => void
  requestNewTodoOpen: () => void
  consumeRequestNewTodo: () => void
}

export const useDispatchStore = create<DispatchState>((set) => ({
  settings: false,
  stats: false,
  wiki: false,
  report: false,
  statsReports: false,
  palette: false,

  openDrawer: (key) => set((s) => ({ ...s, [key]: true, palette: false })),
  closeDrawer: (key) => set(() => ({ [key]: false } as Partial<DispatchState>)),
  closeAllDrawers: () => set(() => ({ settings: false, stats: false, wiki: false, report: false, statsReports: false })),

  openPalette: () => set(() => ({ palette: true })),
  closePalette: () => set(() => ({ palette: false })),
  togglePalette: () => set((s) => ({ palette: !s.palette })),

  openFocus: (todoId, sessionId) => {
    // Close any open palette/drawers, then activate focus mode
    set(() => ({ palette: false, settings: false, stats: false, wiki: false, report: false, statsReports: false }))
    useFocusStore.getState().setFocus(todoId, sessionId ?? null)
  },

  jumpToTodoId: null,
  requestNewTodo: false,
  requestRecover: false,
  requestRecoverOpen: () => set(() => ({ requestRecover: true, palette: false })),
  consumeRequestRecover: () => set(() => ({ requestRecover: false })),

  setJumpTo: (id) => set(() => ({ jumpToTodoId: id })),
  requestNewTodoOpen: () => set(() => ({ requestNewTodo: true })),
  consumeRequestNewTodo: () => set(() => ({ requestNewTodo: false })),
}))
