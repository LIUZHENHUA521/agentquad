import { create } from 'zustand'

export type DrawerKey = 'settings' | 'stats' | 'wiki' | 'report'

interface DispatchState {
  // Drawer open flags (lifted from TodoManage local state)
  settings: boolean
  stats: boolean
  wiki: boolean
  report: boolean

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
}

export const useDispatchStore = create<DispatchState>((set) => ({
  settings: false,
  stats: false,
  wiki: false,
  report: false,
  palette: false,

  openDrawer: (key) => set((s) => ({ ...s, [key]: true, palette: false })),
  closeDrawer: (key) => set(() => ({ [key]: false } as Partial<DispatchState>)),
  closeAllDrawers: () => set(() => ({ settings: false, stats: false, wiki: false, report: false })),

  openPalette: () => set(() => ({ palette: true })),
  closePalette: () => set(() => ({ palette: false })),
  togglePalette: () => set((s) => ({ palette: !s.palette })),
}))
