import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const settingsSource = fs.readFileSync(path.resolve('web/src/SettingsDrawer.tsx'), 'utf8')

// Bug: saving Settings while on the Lark (or any other) tab without ever
// visiting the Telegram tab wipes the saved Telegram config — and vice versa.
//
// Cause: Antd `Tabs` (items API) only mounts the active panel. Inactive
// `Form.Item`s are unregistered from `fieldEntities`, and
// `form.validateFields()` only returns values for currently-registered
// fields. handleSave then reads `values.telegramEnabled` etc. as undefined
// and `Boolean(undefined)` / `'' || ''` zero out the telegram patch.
//
// Fix: keep `validateFields()` for validation, but read the full form store
// via `form.getFieldsValue(true)` when building the API payload.
describe('SettingsDrawer cross-tab save', () => {
  it('handleSave reads the full form store, not just the validated/registered fields', () => {
    // Locate handleSave body (everything between its opening brace and the
    // matching closing brace before handlePickDefaultCwd).
    const startMarker = 'const handleSave = async () => {'
    const endMarker = 'const handlePickDefaultCwd = async () => {'
    const startIdx = settingsSource.indexOf(startMarker)
    const endIdx = settingsSource.indexOf(endMarker, startIdx)
    expect(startIdx).toBeGreaterThan(0)
    expect(endIdx).toBeGreaterThan(startIdx)
    const handleSaveBody = settingsSource.slice(startIdx, endIdx)

    // Must still validate the whole form (so required fields like port still error).
    expect(handleSaveBody).toMatch(/form\.validateFields\(\)/)

    // Must source the values used for the PUT payload from the full store,
    // so unmounted tabs (Telegram when on Lark, etc.) keep their values.
    expect(handleSaveBody).toMatch(/form\.getFieldsValue\(true\)/)

    // Sanity: the request payload still references the merged values, not the
    // raw `validateFields()` return.
    expect(handleSaveBody).toMatch(/telegramEnabled/)
    expect(handleSaveBody).toMatch(/larkEnabled/)
  })
})
