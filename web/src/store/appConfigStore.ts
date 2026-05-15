import { create } from 'zustand'
import { getConfig } from '../api'
import type { AiTool } from '../api'

interface AppConfigState {
  defaultPermissionMode: string | null
  defaultAutoStartAi: boolean
  defaultAiTool: AiTool
  loaded: boolean
  load: () => Promise<void>
  setDefaultPermissionMode: (mode: string | null) => void
  setDefaultAutoStartAi: (value: boolean) => void
  setDefaultAiTool: (tool: AiTool) => void
}

export const useAppConfigStore = create<AppConfigState>((set) => ({
  defaultPermissionMode: null,
  defaultAutoStartAi: false,
  defaultAiTool: 'claude',
  loaded: false,
  load: async () => {
    try {
      const { config } = await getConfig()
      set({
        defaultPermissionMode: config.defaultPermissionMode || null,
        defaultAutoStartAi: !!config.defaultAutoStartAi,
        defaultAiTool: (config.defaultAiTool as AiTool) || 'claude',
        loaded: true,
      })
    } catch {
      set({ loaded: true })
    }
  },
  setDefaultPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
  setDefaultAutoStartAi: (value) => set({ defaultAutoStartAi: value }),
  setDefaultAiTool: (tool) => set({ defaultAiTool: tool }),
}))
