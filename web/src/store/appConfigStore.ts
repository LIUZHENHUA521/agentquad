import { create } from 'zustand'
import { getConfig } from '../api'
import type { AiTool } from '../api'

interface AppConfigState {
  defaultPermissionMode: string | null
  defaultAutoStartAi: boolean
  defaultAppliedTemplateIds: string[]
  defaultAiTool: AiTool
  loaded: boolean
  load: () => Promise<void>
  setDefaultPermissionMode: (mode: string | null) => void
  setDefaultAutoStartAi: (value: boolean) => void
  setDefaultAppliedTemplateIds: (ids: string[]) => void
  setDefaultAiTool: (tool: AiTool) => void
}

export const useAppConfigStore = create<AppConfigState>((set) => ({
  defaultPermissionMode: null,
  defaultAutoStartAi: false,
  defaultAppliedTemplateIds: [],
  defaultAiTool: 'claude',
  loaded: false,
  load: async () => {
    try {
      const { config } = await getConfig()
      set({
        defaultPermissionMode: config.defaultPermissionMode || null,
        defaultAutoStartAi: !!config.defaultAutoStartAi,
        defaultAppliedTemplateIds: Array.isArray(config.defaultAppliedTemplateIds)
          ? config.defaultAppliedTemplateIds.filter((x): x is string => typeof x === 'string')
          : [],
        defaultAiTool: (config.defaultAiTool as AiTool) || 'claude',
        loaded: true,
      })
    } catch {
      set({ loaded: true })
    }
  },
  setDefaultPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
  setDefaultAutoStartAi: (value) => set({ defaultAutoStartAi: value }),
  setDefaultAppliedTemplateIds: (ids) => set({ defaultAppliedTemplateIds: ids }),
  setDefaultAiTool: (tool) => set({ defaultAiTool: tool }),
}))
