// web/src/store/terminalDockStore.ts
import { create } from 'zustand'

export type DockTabStatus = 'running' | 'idle' | 'pending_reply' | 'closed'

export interface DockTab {
  id: string           // = sessionId
  todoId: string
  todoTitle: string
  status: DockTabStatus
  createdAt: number
}

interface DockState {
  openTabs: DockTab[]
  activeTabId: string | null
  splitSecondaryTabId: string | null
  poppedOutTabIds: string[]
  widthPx: number
  isCollapsed: boolean

  activate: (todoId: string, sessionId: string, todoTitle: string) => void
  close: (tabId: string) => void
  setActive: (tabId: string) => void
  reorder: (tabIds: string[]) => void
  splitWith: (tabId: string) => void
  unsplit: () => void
  popOut: (tabId: string) => void
  dock: (tabId: string) => void
  setWidth: (px: number) => void
  toggleCollapsed: () => void
  setStatus: (tabId: string, status: DockTabStatus) => void
  setTodoTitle: (todoId: string, title: string) => void
}

const WIDTH_KEY = 'quadtodo.dock.width'
const COLLAPSED_KEY = 'quadtodo.dock.collapsed'
const MIN_W = 320
const DEFAULT_W = 480

const readWidth = (): number => {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY))
    if (Number.isFinite(v) && v >= MIN_W) return v
  } catch {}
  return DEFAULT_W
}
const readCollapsed = (): boolean => {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return true }
}
const writeWidth = (px: number) => { try { localStorage.setItem(WIDTH_KEY, String(px)) } catch {} }
const writeCollapsed = (c: boolean) => { try { localStorage.setItem(COLLAPSED_KEY, c ? '1' : '0') } catch {} }

export const useTerminalDockStore = create<DockState>((set, get) => ({
  openTabs: [],
  activeTabId: null,
  splitSecondaryTabId: null,
  poppedOutTabIds: [],
  widthPx: readWidth(),
  isCollapsed: readCollapsed(),

  activate: (todoId, sessionId, todoTitle) => {
    const { openTabs } = get()
    const exists = openTabs.find(t => t.id === sessionId)
    if (exists) {
      set({ activeTabId: sessionId, isCollapsed: false })
      writeCollapsed(false)
      return
    }
    const next: DockTab = {
      id: sessionId,
      todoId,
      todoTitle,
      status: 'running',
      createdAt: Date.now(),
    }
    set({ openTabs: [...openTabs, next], activeTabId: sessionId, isCollapsed: false })
    writeCollapsed(false)
  },

  close: (tabId) => {
    const { openTabs, activeTabId, splitSecondaryTabId, poppedOutTabIds } = get()
    const remaining = openTabs.filter(t => t.id !== tabId)
    let nextActive = activeTabId
    if (activeTabId === tabId) {
      nextActive = remaining[remaining.length - 1]?.id ?? null
    }
    set({
      openTabs: remaining,
      activeTabId: nextActive,
      splitSecondaryTabId: splitSecondaryTabId === tabId ? null : splitSecondaryTabId,
      poppedOutTabIds: poppedOutTabIds.filter(id => id !== tabId),
    })
  },

  setActive: (tabId) => set({ activeTabId: tabId }),

  reorder: (tabIds) => {
    const { openTabs } = get()
    const map = new Map(openTabs.map(t => [t.id, t]))
    const next = tabIds.map(id => map.get(id)).filter(Boolean) as DockTab[]
    if (next.length === openTabs.length) set({ openTabs: next })
  },

  splitWith: (tabId) => {
    const { activeTabId } = get()
    if (!activeTabId || activeTabId === tabId) return
    set({ splitSecondaryTabId: tabId })
  },
  unsplit: () => set({ splitSecondaryTabId: null }),

  popOut: (tabId) => {
    const { poppedOutTabIds, openTabs, activeTabId } = get()
    if (poppedOutTabIds.includes(tabId)) return
    if (poppedOutTabIds.length >= 4) return
    let nextActive = activeTabId
    if (activeTabId === tabId) {
      const candidates = openTabs.filter(t => t.id !== tabId && !poppedOutTabIds.includes(t.id))
      nextActive = candidates[candidates.length - 1]?.id ?? null
    }
    set({ poppedOutTabIds: [...poppedOutTabIds, tabId], activeTabId: nextActive })
  },
  dock: (tabId) => {
    const { poppedOutTabIds } = get()
    set({ poppedOutTabIds: poppedOutTabIds.filter(id => id !== tabId) })
  },

  setWidth: (px) => {
    const clamped = Math.max(MIN_W, Math.round(px))
    set({ widthPx: clamped })
    writeWidth(clamped)
  },
  toggleCollapsed: () => {
    const { isCollapsed } = get()
    const next = !isCollapsed
    set({ isCollapsed: next })
    writeCollapsed(next)
  },

  setStatus: (tabId, status) => {
    const { openTabs } = get()
    set({ openTabs: openTabs.map(t => t.id === tabId ? { ...t, status } : t) })
  },
  setTodoTitle: (todoId, title) => {
    const { openTabs } = get()
    set({ openTabs: openTabs.map(t => t.todoId === todoId ? { ...t, todoTitle: title } : t) })
  },
}))

export const DOCK_LIMITS = { MIN_W, DEFAULT_W }
