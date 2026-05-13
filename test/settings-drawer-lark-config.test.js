import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const settingsSource = fs.readFileSync(path.resolve('web/src/SettingsDrawer.tsx'), 'utf8')
const apiSource = fs.readFileSync(path.resolve('web/src/api.ts'), 'utf8')

describe('SettingsDrawer Lark notification settings', () => {
  it('types the Lark config returned by /api/config', () => {
    expect(apiSource).toContain('lark?: {')
    expect(apiSource).toContain('appId?: string')
    expect(apiSource).toContain('appSecret?: string')
    expect(apiSource).toContain('appSecretMasked?: string | null')
    expect(apiSource).toContain("appSecretSource?: 'agentquad' | 'missing'")
    expect(apiSource).toContain('requireThreadGroup?: boolean')
    expect(apiSource).toContain('eventSubscribeEnabled?: boolean')
    expect(apiSource).toContain('autoCreateTopic?: boolean')
    expect(apiSource).toContain("defaultPermissionMode?: 'default' | 'acceptEdits' | 'bypass'")
    expect(apiSource).toContain('notificationCooldownMs?: number')
    expect(apiSource).toContain('export async function testLark')
  })

  it('loads and saves Lark form values through the existing config endpoint', () => {
    expect(settingsSource).toContain('larkAppId: result.config.lark?.appId || \'\'')
    expect(settingsSource).toContain('larkAppSecret: result.config.lark?.appSecretMasked || \'\'')
    expect(settingsSource).toContain('larkEnabled: result.config.lark?.enabled ?? false')
    expect(settingsSource).toContain("larkChatId: result.config.lark?.chatId || ''")
    expect(settingsSource).toContain('larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false')
    expect(settingsSource).toContain('larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false')
    expect(settingsSource).toContain('larkAutoCreateTopic: result.config.lark?.autoCreateTopic !== false')
    expect(settingsSource).toContain("larkDefaultPermissionMode: result.config.lark?.defaultPermissionMode || 'bypass'")
    expect(settingsSource).toContain('larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000')
    expect(settingsSource).toContain('appId: String(values.larkAppId || \'\').trim()')
    expect(settingsSource).toContain('appSecret: values.larkAppSecret || \'\'')
    expect(settingsSource).toContain('enabled: Boolean(values.larkEnabled)')
    expect(settingsSource).toContain("chatId: String(values.larkChatId || '').trim()")
    expect(settingsSource).toContain('requireThreadGroup: values.larkRequireThreadGroup !== false')
    expect(settingsSource).toContain('eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false')
    expect(settingsSource).toContain('autoCreateTopic: values.larkAutoCreateTopic !== false')
    expect(settingsSource).toContain("defaultPermissionMode: values.larkDefaultPermissionMode || 'bypass'")
    expect(settingsSource).toContain('notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0')
  })

  it('exposes Lark settings under a dedicated tab/section with all form items', () => {
    // SettingsDrawer 用 Tabs 切换 telegram / lark / 其他面板；不强制具体 layout，
    // 只验证 Lark 面板的核心 form items + 关键文案存在。
    expect(settingsSource).toContain("key: 'telegram'")
    expect(settingsSource).toContain("key: 'lark'")
    expect(settingsSource).toContain("settings:tab.lark")
    expect(settingsSource).toContain("settings:lark.adaptInfo")
    expect(settingsSource).toContain('name="larkAppId"')
    expect(settingsSource).toContain('name="larkAppSecret"')
    expect(settingsSource).toContain('name="larkEnabled"')
    expect(settingsSource).toContain('name="larkChatId"')
    expect(settingsSource).toContain('name="larkRequireThreadGroup"')
    expect(settingsSource).toContain('name="larkEventSubscribeEnabled"')
    expect(settingsSource).toContain('name="larkAutoCreateTopic"')
    expect(settingsSource).toContain('name="larkDefaultPermissionMode"')
    expect(settingsSource).toContain('name="larkNotificationCooldownMs"')
    expect(settingsSource).toContain("settings:lark.test")
  })
})
