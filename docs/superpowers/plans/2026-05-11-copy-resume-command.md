# Copy Resume Command Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "复制恢复命令" button to each result card in the 历史会话找回 drawer that copies an executable `cd <cwd> && <bin> --resume <id>` string to the clipboard.

**Architecture:** Frontend-only change. A new pure helper module `web/src/transcripts/resumeCommand.ts` builds the command string with POSIX single-quote escaping. `TranscriptSearchDrawer.tsx` calls it, writes to `navigator.clipboard`, shows a toast. No server changes, no new API.

**Tech Stack:** React + TypeScript + Ant Design (existing). Vitest for unit tests (`pnpm test` / `npm test` runs `vitest run`). POSIX shell quoting for bash/zsh.

**Spec:** `docs/superpowers/specs/2026-05-11-copy-resume-command-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `web/src/transcripts/resumeCommand.ts` | **create** | Pure `buildResumeCommand` + `posixEscape` helpers; no React, no DOM, no fetch. |
| `test/transcripts.resume-command.test.ts` | **create** | Vitest unit tests for the helper. Lives in repo-root `test/` per existing convention (see `test/reply-hub.test.ts` which imports from `web/src/replyHub.ts`). |
| `web/src/transcripts/TranscriptSearchDrawer.tsx` | **modify** | Import `CopyOutlined` + `buildResumeCommand`; render the button in the existing `<Space>` row at line ~270; wire click handler. |

---

## Task 1: Create the pure command builder + tests

**Files:**
- Create: `web/src/transcripts/resumeCommand.ts`
- Test:   `test/transcripts.resume-command.test.ts`

This is pure TypeScript with no React. Write the tests first, watch them fail, then implement.

### - [ ] Step 1: Write the failing test file

Create `test/transcripts.resume-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildResumeCommand, posixEscape } from '../web/src/transcripts/resumeCommand.ts'

describe('posixEscape', () => {
  it('wraps simple strings in single quotes', () => {
    expect(posixEscape('hello')).toBe("'hello'")
  })

  it('escapes single quotes by closing, escaping, reopening', () => {
    expect(posixEscape("O'Reilly")).toBe("'O'\\''Reilly'")
  })

  it('handles empty string', () => {
    expect(posixEscape('')).toBe("''")
  })

  it('preserves spaces and slashes inside the quoted body', () => {
    expect(posixEscape('/Users/x/some dir')).toBe("'/Users/x/some dir'")
  })
})

describe('buildResumeCommand', () => {
  const ID = 'abcd1234-ef56-7890-1234-567890abcdef'

  it('claude with cwd → cd && claude --resume', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: '/Users/x/proj' })
    expect(r.command).toBe(`cd '/Users/x/proj' && claude --resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('claude with null cwd → bare claude --resume + cwd_missing warning', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: null })
    expect(r.command).toBe(`claude --resume '${ID}'`)
    expect(r.warnings).toEqual(['cwd_missing'])
  })

  it('claude with empty-string cwd → bare command + cwd_missing warning', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: '' })
    expect(r.command).toBe(`claude --resume '${ID}'`)
    expect(r.warnings).toEqual(['cwd_missing'])
  })

  it('codex with cwd → cd && codex resume (no --)', () => {
    const r = buildResumeCommand({ tool: 'codex', native_id: ID, cwd: '/x' })
    expect(r.command).toBe(`cd '/x' && codex resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('cursor with cwd → cd && cursor-agent --resume', () => {
    const r = buildResumeCommand({ tool: 'cursor', native_id: ID, cwd: '/x' })
    expect(r.command).toBe(`cd '/x' && cursor-agent --resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('escapes single quotes inside cwd', () => {
    const r = buildResumeCommand({ tool: 'claude', native_id: ID, cwd: "/Users/O'Reilly/x" })
    expect(r.command).toBe(`cd '/Users/O'\\''Reilly/x' && claude --resume '${ID}'`)
    expect(r.warnings).toEqual([])
  })

  it('throws on unsupported tool', () => {
    expect(() => buildResumeCommand({ tool: 'unknown' as never, native_id: ID, cwd: '/x' })).toThrow(/unsupported tool/)
  })

  it('throws on empty native_id', () => {
    expect(() => buildResumeCommand({ tool: 'claude', native_id: '', cwd: '/x' })).toThrow(/native_id/)
  })
})
```

### - [ ] Step 2: Run tests and confirm they fail

Run from repo root:

```bash
npx vitest run test/transcripts.resume-command.test.ts
```

Expected: All tests fail with a module-resolution error (file `web/src/transcripts/resumeCommand.ts` does not exist).

### - [ ] Step 3: Implement the helper

Create `web/src/transcripts/resumeCommand.ts`:

```ts
export type ResumeTool = 'claude' | 'codex' | 'cursor'

const BIN: Record<ResumeTool, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
}

export function posixEscape(s: string): string {
  // POSIX single-quote rule: a single quote inside a single-quoted string
  // must be closed, escaped with backslash, and reopened: '...'\''...'.
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function buildResumeCommand(input: {
  tool: ResumeTool
  native_id: string
  cwd: string | null
}): { command: string; warnings: string[] } {
  const { tool, native_id, cwd } = input
  if (!BIN[tool]) {
    throw new Error(`unsupported tool: ${tool}`)
  }
  if (!native_id) {
    throw new Error('native_id is required')
  }
  const bin = BIN[tool]
  const resumeFlag = tool === 'codex' ? 'resume' : '--resume'
  const tail = `${bin} ${resumeFlag} ${posixEscape(native_id)}`

  const warnings: string[] = []
  if (!cwd) {
    warnings.push('cwd_missing')
    return { command: tail, warnings }
  }
  return { command: `cd ${posixEscape(cwd)} && ${tail}`, warnings }
}
```

### - [ ] Step 4: Run tests and confirm they pass

```bash
npx vitest run test/transcripts.resume-command.test.ts
```

Expected: All 12 tests pass (4 in `posixEscape` describe + 8 in `buildResumeCommand` describe).

If any test fails, fix the implementation — not the test. Common pitfalls:
- The single-quote-escape test compares against a TypeScript string literal `"'O'\\''Reilly'"`. In TS source that's the 9-char sequence: `' O ' \ ' ' R e i l l y '`. The escape sequence produced by code is `'\''`. Make sure you didn't accidentally double-escape.

### - [ ] Step 5: Commit

```bash
git add web/src/transcripts/resumeCommand.ts test/transcripts.resume-command.test.ts
git commit -m "$(cat <<'EOF'
feat(transcripts): add buildResumeCommand helper

Pure function that composes `cd <cwd> && <bin> --resume <id>` from a
TranscriptFile, with POSIX single-quote escaping. Frontend-only; no
server changes. Covered by 12 vitest cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the button into TranscriptSearchDrawer

**Files:**
- Modify: `web/src/transcripts/TranscriptSearchDrawer.tsx` (icon import on line 3; helper import after the api import block ending ~line 7; button + handlers inside the result-card map at lines ~270-278)

### - [ ] Step 1: Add the `CopyOutlined` icon import

Edit `web/src/transcripts/TranscriptSearchDrawer.tsx` line 3:

**Before:**
```tsx
import { ReloadOutlined, LinkOutlined, DisconnectOutlined, SearchOutlined } from '@ant-design/icons'
```

**After:**
```tsx
import { ReloadOutlined, LinkOutlined, DisconnectOutlined, SearchOutlined, CopyOutlined } from '@ant-design/icons'
```

### - [ ] Step 2: Import the helper

After the existing api import block (ending around line 7), add:

```tsx
import { buildResumeCommand, type ResumeTool } from './resumeCommand'
```

### - [ ] Step 3: Add the click handler + predicate inside the component

Inside `export default function TranscriptSearchDrawer(...)`, just below the existing `function toggleTurnExpand` (around line 197) and above the `todoOptions` useMemo, add:

```tsx
  const COPY_SUPPORTED_TOOLS: ResumeTool[] = ['claude', 'codex', 'cursor']

  function canCopyResume(f: TranscriptFile): boolean {
    return !!f.native_id && (COPY_SUPPORTED_TOOLS as string[]).includes(f.tool)
  }

  function copyDisabledReason(f: TranscriptFile): string {
    if (!f.native_id) return '该记录无 native session id'
    if (!(COPY_SUPPORTED_TOOLS as string[]).includes(f.tool)) return '暂不支持该工具'
    return ''
  }

  async function handleCopyResume(f: TranscriptFile) {
    try {
      const { command, warnings } = buildResumeCommand({
        tool: f.tool as ResumeTool,
        native_id: f.native_id as string,
        cwd: f.cwd,
      })
      await navigator.clipboard.writeText(command)
      const display = command.length > 80 ? command.slice(0, 80) + '…' : command
      message.success(`已复制：${display}`)
      if (warnings.includes('cwd_missing')) {
        message.warning('未识别 cwd，请先 cd 到原工作目录')
      }
    } catch (e) {
      message.error('复制失败，请手动复制')
    }
  }
```

### - [ ] Step 4: Render the button in the action row

Find the `<Space size={4} style={{ marginTop: 8 }}>` block inside the result-card map (currently around lines 270-278). It looks like:

```tsx
                      <Space size={4} style={{ marginTop: 8 }}>
                        <Button size="small" onClick={() => handlePreview(f)}>预览</Button>
                        <Button size="small" type="primary" icon={<LinkOutlined />} onClick={() => { setBindTargetFile(f); setBindTodoId(preselectTodoId || '') }}>
                          {boundTodo ? '改挂…' : '绑定到 todo…'}
                        </Button>
                        {boundTodo && (
                          <Button size="small" danger icon={<DisconnectOutlined />} onClick={() => handleUnbind(f)}>解绑</Button>
                        )}
                      </Space>
```

Append the new button as the last child of `<Space>`, **after** the existing `{boundTodo && ...}` clause:

```tsx
                      <Space size={4} style={{ marginTop: 8 }}>
                        <Button size="small" onClick={() => handlePreview(f)}>预览</Button>
                        <Button size="small" type="primary" icon={<LinkOutlined />} onClick={() => { setBindTargetFile(f); setBindTodoId(preselectTodoId || '') }}>
                          {boundTodo ? '改挂…' : '绑定到 todo…'}
                        </Button>
                        {boundTodo && (
                          <Button size="small" danger icon={<DisconnectOutlined />} onClick={() => handleUnbind(f)}>解绑</Button>
                        )}
                        <Tooltip title={canCopyResume(f) ? undefined : copyDisabledReason(f)}>
                          <Button
                            size="small"
                            icon={<CopyOutlined />}
                            disabled={!canCopyResume(f)}
                            onClick={() => handleCopyResume(f)}
                          >
                            复制恢复命令
                          </Button>
                        </Tooltip>
                      </Space>
```

`Tooltip` is already imported on line 2 — verify before edit:

```bash
grep -n "Tooltip" web/src/transcripts/TranscriptSearchDrawer.tsx | head -3
```

Expected: line 2 already imports `Tooltip` from `'antd'`. If not, add it.

### - [ ] Step 5: TypeScript check + build the web bundle

```bash
npm run build
```

Expected: build succeeds with no TypeScript errors. The build script is `npm run ensure-web-deps && npm run build:web` per `package.json`.

If TS complains about `f.tool as ResumeTool` being unsafe, that's OK — we've gated it behind `canCopyResume`. If it complains about the import path, ensure `resumeCommand` is imported without extension (matching repo convention).

### - [ ] Step 6: Run the full vitest suite

```bash
npm test
```

Expected: all tests pass, including the 12 new `transcripts.resume-command` tests from Task 1. No prior tests should regress (we only added new code paths).

### - [ ] Step 7: Manual smoke test

The dev server needs to be running. From repo root:

```bash
# In one terminal:
node src/cli.js start

# Open http://localhost:<port>/  (port shown in CLI output)
```

Manual checklist (per AC-1 through AC-5 in the spec):

1. Open「历史会话找回」drawer (from todo card → 找历史会话 entry, or wherever it's reachable).
2. Verify every result card shows the new「复制恢复命令」button in the action row.
3. Click it on a `claude` row with non-empty `cwd`:
   - Toast: `已复制：cd '/...' && claude --resume '...'`
   - Paste into a separate terminal → confirm it's the expected command.
4. Find / fabricate a row with `cwd=null` (rare, but possible — Codex sessions before sidecar bootstrap):
   - Toast: success + warning `未识别 cwd, 请先 cd 到原工作目录`.
5. Find a row with no `native_id` (unbound `cursor` row pre-detect): button is disabled, hover shows `该记录无 native session id`.

If any of these fails, stop and debug — do not commit a broken button.

### - [ ] Step 8: Commit

```bash
git add web/src/transcripts/TranscriptSearchDrawer.tsx
git commit -m "$(cat <<'EOF'
feat(transcripts): copy-resume-command button in rescue drawer

Each result card in 历史会话找回 now has a "复制恢复命令" button that
writes `cd <cwd> && <bin> --resume <id>` to the clipboard, with POSIX
escaping for spaces / quotes. Disabled when native_id or tool support
is missing; warns when cwd is empty.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (done by plan author)

**Spec coverage:**
- AC-1 (button visible per card) → Task 2 Step 4.
- AC-2 (clipboard write + success toast) → Task 2 Step 3 `handleCopyResume`.
- AC-3 (disabled when invalid) → Task 2 Step 3 `canCopyResume` + Step 4 `disabled` prop + Tooltip.
- AC-4 (cwd-missing degrade + warning) → Task 1 helper `cwd_missing` warning + Task 2 Step 3 `message.warning`.
- AC-5 (shell escaping) → Task 1 `posixEscape` + 4 tests in Task 1 Step 1.
- AC-6 (no regressions) → Task 2 Step 6 `npm test`.
- AC-7 (vitest passes) → Task 2 Step 6 `npm test`.

**Placeholder scan:** No "TODO", "TBD", or hand-wavy steps. Each code step shows the full code. ✓

**Type consistency:** `ResumeTool`, `buildResumeCommand`, `posixEscape` are defined in Task 1 and referenced by the same names in Task 2. ✓
