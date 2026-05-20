import { create } from 'zustand'

export type FocusTab = 'conversation' | 'live'

export type SetFocusOpts = {
  /** 进入 focus 后让 TranscriptView 顶栏搜索框预填的关键词;consumeInitialKeyword 后清空 */
  initialKeyword?: string
  /** 强制初始 tab;不传则沿用默认 'live' */
  initialTab?: FocusTab
}

interface FocusState {
  /** Currently-focused todo (null = no focus / Grid mode) */
  focusedTodoId: string | null
  /** The session ID being shown in focus (may be null if todo has no active session) */
  focusedSessionId: string | null
  /** Active tab inside Focus Mode */
  focusedTab: FocusTab
  /** 进入 focus 后由 TranscriptView 一次性消费的初始搜索词 */
  pendingInitialKeyword: string | null

  setFocus: (todoId: string | null, sessionId?: string | null, opts?: SetFocusOpts) => void
  clearFocus: () => void
  setTab: (tab: FocusTab) => void
  replaceFocusedSession: (oldId: string, nextId: string) => void
  /** TranscriptView 在 mount / sessionId 变化时调一次,消费后清空,避免下次再被错误预填 */
  consumeInitialKeyword: () => string | null
}

export const useFocusStore = create<FocusState>((set, get) => ({
  focusedTodoId: null,
  focusedSessionId: null,
  focusedTab: 'live',  // Default landing tab: Live terminal (first tab)
  pendingInitialKeyword: null,

  setFocus: (todoId, sessionId, opts) => set(() => ({
    focusedTodoId: todoId,
    focusedSessionId: sessionId ?? null,
    focusedTab: opts?.initialTab ?? 'live',
    pendingInitialKeyword: opts?.initialKeyword ?? null,
  })),
  clearFocus: () => set(() => ({ focusedTodoId: null, focusedSessionId: null, pendingInitialKeyword: null })),
  setTab: (tab) => set(() => ({ focusedTab: tab })),
  replaceFocusedSession: (oldId, nextId) => set((state) => {
    if (state.focusedSessionId !== oldId) return state
    return { focusedSessionId: nextId }
  }),
  consumeInitialKeyword: () => {
    const kw = get().pendingInitialKeyword
    if (kw !== null) set(() => ({ pendingInitialKeyword: null }))
    return kw
  },
}))
