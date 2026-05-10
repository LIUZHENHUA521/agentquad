import { create } from 'zustand'

type CloseHandler = () => void

interface DrawerStackState {
  // drawers that have registered a close handler keyed by drawerKey
  registered: Record<string, CloseHandler>
  // open order; last element is topmost
  stack: string[]

  register: (key: string, onClose: CloseHandler) => void
  unregister: (key: string) => void
  open: (key: string) => void   // push to top (or move to top if already present)
  close: (key: string) => void  // remove from stack
  topKey: () => string | null
}

export const useDrawerStackStore = create<DrawerStackState>((set, get) => ({
  registered: {},
  stack: [],

  register: (key, onClose) => set(s => ({
    registered: { ...s.registered, [key]: onClose },
  })),

  unregister: (key) => set(s => {
    const next = { ...s.registered }
    delete next[key]
    return {
      registered: next,
      stack: s.stack.filter(k => k !== key),
    }
  }),

  open: (key) => set(s => ({
    stack: [...s.stack.filter(k => k !== key), key],
  })),

  close: (key) => set(s => ({
    stack: s.stack.filter(k => k !== key),
  })),

  topKey: () => {
    const { stack } = get()
    return stack[stack.length - 1] ?? null
  },
}))
