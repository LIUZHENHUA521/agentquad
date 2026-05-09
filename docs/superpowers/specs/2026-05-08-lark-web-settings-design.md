# Lark Web Settings Design

## Goal

Expose the existing Lark/Feishu notification configuration in the Web settings drawer so users can enable and configure Lark without editing config files by hand.

## Scope

This change is UI/API typing only. It does not change the Lark bot runtime, Lark routing semantics, or Telegram behavior.

## Layout

Replace the current standalone Telegram settings presentation with a broader **通知渠道** section. Inside it, show two sibling panels:

1. **Telegram** — keeps the current Telegram fields and grouping.
2. **Lark / 飞书** — adds the Lark fields backed by the existing server config.

The Telegram form field names and save payload stay the same. The only visual change for Telegram is that it now appears under the notification-channel section rather than as a standalone top-level block.

## Lark Fields

The Lark panel exposes these fields:

- **启用 Lark / 飞书通知** → `lark.enabled`
- **话题群 Chat ID** → `lark.chatId`
- **要求目标群为话题群 / thread group** → `lark.requireThreadGroup`
- **启用事件订阅，用于双向消息** → `lark.eventSubscribeEnabled`
- **通知冷却时间 ms** → `lark.notificationCooldownMs`

A short help message explains that Lark topic behavior is implemented through a root message/thread in a thread-mode group, not through Telegram-style native forum topics.

## Data Flow

`web/src/api.ts` adds `AppConfig.lark` with the same shape as the server config:

```ts
lark?: {
  enabled?: boolean
  chatId?: string
  requireThreadGroup?: boolean
  eventSubscribeEnabled?: boolean
  notificationCooldownMs?: number
}
```

`SettingsDrawer` loads Lark values from `getConfig()` into form fields with server-compatible defaults:

```ts
larkEnabled: result.config.lark?.enabled ?? false
larkChatId: result.config.lark?.chatId || ''
larkRequireThreadGroup: result.config.lark?.requireThreadGroup !== false
larkEventSubscribeEnabled: result.config.lark?.eventSubscribeEnabled !== false
larkNotificationCooldownMs: result.config.lark?.notificationCooldownMs ?? 600000
```

On save, `SettingsDrawer` includes a `lark` object in the existing `updateConfig()` payload:

```ts
lark: {
  enabled: Boolean(values.larkEnabled),
  chatId: String(values.larkChatId || '').trim(),
  requireThreadGroup: values.larkRequireThreadGroup !== false,
  eventSubscribeEnabled: values.larkEventSubscribeEnabled !== false,
  notificationCooldownMs: Number(values.larkNotificationCooldownMs) || 0,
}
```

## Error Handling

Use the existing settings drawer save flow. If `/api/config` rejects the payload, the current error handling and message display remain responsible for surfacing the failure. No new client-side validation is added beyond trimming `chatId` and numeric coercion for cooldown.

## Testing

Verification should cover:

1. TypeScript build or Web build accepts the new `AppConfig.lark` shape.
2. Lark form values are loaded from `/api/config` defaults.
3. Saving settings includes the `lark` payload.
4. Existing Telegram settings remain present and keep their current field names and payload behavior.

## Acceptance Criteria

- The Web settings drawer contains a **通知渠道** section.
- Telegram remains configurable from the same drawer.
- Lark / 飞书 settings are visible and editable.
- Saving the drawer persists Lark fields through `/api/config`.
- Existing backend Lark defaults are reflected in the UI when no Lark config was previously saved.
- No Telegram runtime or payload behavior changes beyond UI grouping.
