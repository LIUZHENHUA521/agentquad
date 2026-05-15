# Config loss fix — design

**Date:** 2026-05-15
**Scope:** Stop AgentQuad config (`~/.agentquad/config.json`) from intermittently losing fields, especially Telegram / Lark settings.

## Background

User reported: 「我设置的有些配置，有的时候会丢」 — Telegram and Lark sections have been wiped before. Code audit surfaced 6 mechanisms that can each lose data, with one smoking-gun specific to the Telegram/Lark case.

## Root causes

| # | Where | What goes wrong |
|---|-------|-----------------|
| R1 | `src/config.js:482-499` `loadConfig()` rewrites `config.json` on **every read** | Any GET overlaps with a concurrent PUT → last writer wins, the other side's changes vanish. |
| R2 | `src/server.js:641-714` `PUT /api/config` is read-merge-save without serialization | Two PUTs interleave → second one's "current" snapshot pre-dates first one's save → first one's changes overwritten. |
| R3 | `src/config.js:494-499` corrupt-parse path resets to **defaults** | A truncated write (R4) → next load resets entire config. |
| R4 | `src/config.js:473-480` `writeFileSync` in-place, non-atomic | SIGKILL / power-cut mid-write → corrupt file → triggers R3. |
| R5 | `src/config.js:43-57` rootDir falls back through 4 paths | Different cwd/env reads/writes a different file (deferred — out of scope here). |
| **R6 (smoking gun)** | `web/src/SettingsDrawer.tsx:246-320` always PUTs full `telegram` + `lark` payload, even when user only touched another tab. Server has guards only for `botToken` / `appSecret` (mask & empty); plain fields like `appId`, `chatId`, `supergroupId` have **no empty-string guard** | If the form's section was never initialized (race with `getConfig`, error, init aborted), the PUT body has `appId: ""` → server writes `""` → config field wiped. Once wiped, every subsequent save propagates the empty value. |

R6 is the most likely culprit for the user-visible Telegram/Lark loss (intermittent + sticky).

## Fix plan (4 items — server-side only, surgical)

### F1 — Server treats empty strings as "no change" for telegram/lark fields
**File:** `src/server.js` PUT `/api/config`
**Change:** Extend the existing `botToken === ''` / `appSecret === ''` skip-pattern to **every string field** in `telegramPatch` and `larkPatch`. If `''`, delete from patch before merging. Use `null` for explicit clear.
**Why:** Defense in depth — frontend bugs (race, form-not-initialized) can never wipe disk values. Backend is the source of truth.

### F2 — `loadConfig` no longer writes on read
**File:** `src/config.js:482-499`
**Change:** Remove `tryWriteConfig(file, cfg)` in the read-success branch. Keep first-run creation and corrupt-recovery writes. Normalize stays in-memory.
**Why:** Eliminates the entire class of GET-vs-PUT races (R1) at the cost of: new default fields no longer auto-materialize on disk until something writes. Acceptable.

### F3 — Atomic config writes
**File:** `src/config.js:473-480` `tryWriteConfig` + `saveConfig`
**Change:** Write to `config.json.<pid>.<ts>.tmp` then `renameSync` over `config.json`. Best-effort `fs.fsync` of file then dir. POSIX rename is atomic — readers see either the old or new file, never a half-written one.
**Why:** Eliminates R3/R4 — crashes never leave a corrupt file, so never reset to defaults.

### F4 — In-process write serialization
**File:** `src/config.js`
**Change:** Add a module-level Promise chain (`let writeQueue = Promise.resolve()`); export `withConfigLock(fn)` that chains `fn` onto the queue and returns its result. Wrap `saveConfig`, `setConfigValue` body, and the PUT handler's read-merge-save block in `withConfigLock`.
**Why:** Eliminates R2 — concurrent server-side writes are serialized. Cross-process (CLI/hooks) is **out of scope** (deferred; current symptom is web-driven).

## Out of scope (deferred)

- R5 (rootDir resolution) — only matters if user mixes cwds; user hasn't reported this.
- Cross-process locking (CLI / hooks). Will revisit if symptoms persist after F1-F4.
- Drawer refactor to send only dirty sections — F1 makes this unnecessary for safety.
- Rolling backups of `config.json` — nice-to-have, not needed once F3 lands.

## Acceptance criteria

1. Burst 5 sequential PUTs from Drawer → disk reflects the **last** payload, never an intermediate snapshot.
2. 10 concurrent PUTs → disk equals exactly one of the payloads (atomic; no field-level interleave).
3. SIGKILL mid-write (between tmp-write and rename) → reload returns last-successful version, **not defaults**.
4. 100 sequential GETs → `config.json` mtime unchanged.
5. **R6 regression test:** PUT `{telegram: {supergroupId: ''}, lark: {appId: ''}}` against a config with pre-existing values → disk values **preserved**.
6. Existing `test/config.test.js`, `test/server.config-mask.test.js`, `test/settings-drawer-lark-config.test.js` all green.
7. New tests for (1), (2), (5) added.

## Files touched

- `src/config.js` — F2, F3, F4 (~50 lines)
- `src/server.js` — F1, F4 wrap (~30 lines)
- `test/config.test.js` or new test file — atomicity + serialization (~80 lines)
- `test/server.config-mask.test.js` or new — empty-string preservation (~40 lines)
