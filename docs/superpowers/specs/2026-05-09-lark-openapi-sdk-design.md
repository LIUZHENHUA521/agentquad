# Lark OpenAPI SDK Design

## Goal

Remove the user-facing dependency on local `lark-cli` for Lark / Feishu bidirectional notifications. quadtodo should send messages and receive Lark message events directly through the official Lark OpenAPI Node SDK.

## Scope

This change replaces the runtime Lark transport only. It keeps the existing task/topic behavior:

- one task starts one Lark thread root message;
- AI output replies inside that thread;
- user replies in that thread route back to the local PTY;
- Telegram behavior remains unchanged.

The new user setup path should not require installing `lark-cli`, running `lark-cli config init`, exposing a webhook URL, or configuring ngrok/tunnel.

## Chosen Approach

Use the official `@larksuiteoapi/node-sdk` package for both outbound OpenAPI calls and inbound long-connection events.

- Outbound messages use the SDK `Client`.
- Inbound `im.message.receive_v1` events use the SDK `WSClient` long-connection mode.
- `src/lark-bot.js` keeps its current public interface so `openclaw-bridge`, `openclaw-wizard`, and server lifecycle wiring stay mostly unchanged.

This mirrors the user experience of `lark-cli event +subscribe`, but embeds the capability in quadtodo.

## User Configuration

The Web settings Lark panel adds application credentials:

- App ID
- App Secret
- Chat ID
- Require thread group
- Enable event subscription
- Notification cooldown

`App Secret` behaves like the Telegram bot token:

- PUT accepts a new secret.
- GET never returns the plaintext secret.
- GET returns `appSecretMasked` and `appSecretSource` or equivalent status metadata.
- Saving with an empty/masked secret keeps the existing secret.

The user still needs to create a Feishu/Lark self-built app, enable bot capability, add the bot to the target thread group, and grant the required message/event permissions. The user does not need local CLI setup.

## Backend Configuration

Extend `config.lark` with SDK credentials:

```js
{
  enabled: false,
  appId: '',
  appSecret: '',
  chatId: '',
  requireThreadGroup: true,
  eventSubscribeEnabled: true,
  notificationCooldownMs: 600000,
}
```

Runtime and API responses must mask `appSecret` before returning config to Web clients.

## Components

### `src/lark-api-client.js`

A focused wrapper around `@larksuiteoapi/node-sdk` `Client`.

Responsibilities:

- Create a self-built-app SDK client from `appId` and `appSecret`.
- Send a root message to a chat:

```js
client.im.message.create({
  params: { receive_id_type: 'chat_id' },
  data: {
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text }),
  },
})
```

- Reply inside a thread:

```js
client.im.message.reply({
  path: { message_id: rootMessageId },
  data: {
    msg_type: 'text',
    content: JSON.stringify({ text }),
    reply_in_thread: true,
  },
})
```

- Return normalized results that match the current `lark-cli` wrapper shape:

```js
{ ok: true, payload }
{ ok: false, reason, detail }
```

- Expose `testConnection()` for a Web “test Lark connection” action. The test validates `appId` and `appSecret` by requesting a tenant access token through the official auth endpoint or SDK token path. It must not send a real message to the configured chat.

The SDK handles tenant access token fetching and token cache internally for message and WebSocket operations, so quadtodo should not implement its own token cache for normal runtime calls.

### `src/lark-event-client.js`

A focused wrapper around SDK `WSClient`.

Responsibilities:

- Create `WSClient` from `appId` and `appSecret`.
- Register `im.message.receive_v1` with `EventDispatcher`.
- Normalize event payloads to the same shape consumed by existing Lark event handling.
- Start and stop the long connection with server lifecycle.
- Surface connection failures as structured log messages and `describe()` status.

Long-connection mode is chosen because it does not require a public webhook URL. The running environment only needs outbound network access to the Lark/Feishu open platform.

### `src/lark-bot.js`

Keep the existing exported `createLarkBot()` shape:

```js
{
  start,
  stop,
  describe,
  sendMessage,
  replyInThread,
  handleEvent,
}
```

Change internals from spawning `lark-cli` to composing:

- `larkApiClient.sendMessage()`
- `larkApiClient.replyInThread()`
- `larkEventClient.start()` / `stop()`

Retain current behavior:

- chat filtering by configured `chatId`;
- ignoring app/bot self messages;
- event dedupe;
- wizard failure redelivery semantics;
- outbound reply retry after successful wizard handling.

### Server lifecycle

`src/server.js` keeps the current Lark stack lifecycle:

- start Lark stack if `config.lark.enabled`;
- restart it when Lark config changes;
- stop and clear it on server close;
- ensure `openclaw-bridge` gets a real bot only when Lark runtime is available.

The restart trigger should include credential changes (`appId`, `appSecret`) in addition to existing Lark fields.

### Web UI

Extend the existing **通知渠道 → Lark / 飞书** panel with:

- App ID input
- App Secret password input
- credential status tag
- optional test button

Keep existing Lark fields and Telegram fields unchanged.

## Error Handling

Use structured `reason` strings that can be tested and surfaced in logs:

- `lark_credentials_missing`
- `lark_client_init_failed`
- `lark_send_failed`
- `lark_reply_failed`
- `lark_ws_start_failed`
- `lark_event_handler_failed`

If Lark is enabled but credentials are missing, startup should not crash quadtodo. It should log a clear warning and `postText()` should fail closed with a structured reason rather than falling back to another channel.

## Permissions and Setup Notes

The self-built app needs permissions for:

- sending messages as bot;
- receiving `im.message.receive_v1` events;
- reading enough message metadata to identify chat, message, thread/root message, sender, and content.

The bot must be added to the target Lark thread group.

## Testing

Tests should mock the SDK classes instead of making real network calls.

Required coverage:

1. Config defaults and normalization include `appId` and masked `appSecret` behavior.
2. `/api/config` never returns plaintext `appSecret`.
3. Web settings load/save App ID and App Secret fields.
4. `lark-api-client` sends root messages with `receive_id_type=chat_id` and text JSON content.
5. `lark-api-client` replies with `reply_in_thread: true`.
6. `lark-event-client` registers `im.message.receive_v1` and calls the existing event handler.
7. `lark-bot` keeps current dedupe, self-message filtering, retry, and wizard routing behavior while using SDK clients instead of CLI spawn.
8. Server restart logic reacts to Lark credential/config changes.
9. Existing Telegram tests continue to pass.

## Acceptance Criteria

- Users can configure Lark from quadtodo Web without installing `lark-cli`.
- quadtodo can send Lark root messages and thread replies through OpenAPI SDK calls.
- quadtodo can receive `im.message.receive_v1` through Lark long-connection mode without a public webhook URL.
- App Secret is never returned to the Web client in plaintext.
- Existing Lark task/thread routing behavior remains intact.
- Existing Telegram behavior remains intact.
