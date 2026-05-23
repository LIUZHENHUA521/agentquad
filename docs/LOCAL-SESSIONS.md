# Local Session Auto-Capture

When you run `claude` or `codex` directly in a terminal (outside the AgentQuad web UI), AgentQuad can still detect the session via hook callbacks, create a matching todo card automatically, and route notifications to your default Telegram / Lark route.

## Setup

1. Configure default routes in `~/.agentquad/config.json`:

   ```json
   {
     "localSessions": {
       "autoCapture": { "enabled": true, "redactCwd": "basename" },
       "defaultTelegramRoute": { "chatId": YOUR_CHAT_ID },
       "defaultLarkRoute": null
     }
   }
   ```

2. Restart AgentQuad: `agentquad restart`

Hooks are installed (or upgraded) automatically on server startup when `~/.claude/` or `~/.codex/` exists. If you'd rather manage hooks yourself, set `localSessions.autoInstallHooks: false` and run `agentquad install claude` / `agentquad install codex` manually.

## Behavior

| Tool | Card appears when | Status flow |
|------|-------------------|-------------|
| claude | SessionStart hook (1–2s of `claude` launch) | running → pending_confirm (Notification) → idle (Stop) → done (SessionEnd) |
| codex | First `UserPromptSubmit` (after user types first prompt) | running → idle (Stop) → done (30min silent timeout) |

**Codex limitation**: codex hook protocol has no equivalent of claude's `Notification` event, so codex local sessions never enter the "pending_confirm" board column. Adopting the session (see below) lifts this restriction because the PTY transfers to AgentQuad and the existing confirm-pattern detector takes over.

## Title Convention

- Phase 1 (at creation, claude only): `[本地 claude] <cwd-basename> · HH:mm`
- Phase 2 (after first prompt, claude only): `[本地 claude] <cwd-basename> · "<first 30 chars of prompt>…"`
- Codex always creates with the Phase-2 style since it only appears after the first prompt
- User-edited titles are protected: a rename only fires when the current title still matches the Phase 1 regex

## Opt-Out

- Globally: set `localSessions.autoCapture.enabled = false` in config
- One-shot: `AGENTQUAD_SKIP_CAPTURE=1 claude`

## Adopting a Session

A web "接管" (Take Over) button appears on local-capture cards while the session is still running. Clicking it:

1. Spawns `claude --resume <id>` / `codex resume <id>` under AgentQuad's PTY manager
2. Marks the session as `source=adopted`
3. Makes the session a first-class AgentQuad session (Telegram/Lark topics, web xterm streaming, etc.)

**You must close the local `claude`/`codex` process first** — two processes claiming the same session id will conflict.

## Hook Version & Upgrade Banner

`agentquad install claude` writes a version marker into your `~/.claude/settings.json`. When the AgentQuad server starts up, it compares the installed version against the version it expects. If yours is older, a warning banner appears in the web UI prompting you to re-run `agentquad install claude`. The banner is dismissible via close button (persisted in `localStorage`).

If you've never installed hooks, no banner appears — you're not opting into the feature.

## Privacy

- `redactCwd: 'basename'` (default) sends only the directory name to IM, not the full path. Other valid values: `'full'` (whole path), `'none'` (omit cwd entirely)
- Initial prompts are truncated to 200 chars in the todo description
- The server stays bound to `127.0.0.1` — hooks POST to localhost, never an external IP
