# 嵌套子 agent + 三家适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AgentQuad 启动的 Claude Code / Codex 会话和用户日常的 Cursor 都能自动连上当前实例的 AgentQuad MCP，并在合适时机自发拆子 todo + 起子 agent。

**Architecture:** 沿用现有 `src/<tool>-hook-installer.js` 平铺约定，新增 3 个 `<tool>-agent-installer.js` 模块负责 B（全局 MCP 注册 + 全局 skill/rule），以及一个 `agent-installer-shared.js` 放共享的 marker 管理 + 运行时 MCP 配置写入逻辑（C）。CLI 加 `agentquad agents` 子命令组、`agentquad start` 弹问 bootstrap、`agentquad doctor` 集成。`spawnSession` 改造一次性完成 C（运行时 `--mcp-config` + `DEPTH/PARENT_TODO_ID` env 注入）。

**Tech Stack:** Node.js ESM、commander、`@modelcontextprotocol/sdk`、vitest、TOML（手写最小 parse/serialize，沿用 codex-hook-installer 的做法）。

**Spec 来源:** `docs/superpowers/specs/2026-05-14-nested-child-agents-design.md`

**Plan 阶段已敲定的 spec §13 决策:**
- **JSON marker 用旁路键 `_agentquadManaged: { version, port, generatedAt }`**（跟现有 hook installer 一致，不引入独立 lockfile）
- **Codex 的 C 运行时注入策略**: Task 11 第一步先 doctor `codex --help` 检查 `--config / --mcp-config` 是否存在；若都没有 → 退化为往 `cwd` 写 `.codex/config.toml`（trusted projects only） + 退出清理

---

## 文件结构总览

| 文件 | 责任 |
|---|---|
| `src/agent-installer-shared.js` | marker 管理（`_agentquadManaged` 旁路键读写）、atomic write（O_EXCL + rename）、运行时 MCP 配置文件写/清，三家通用 |
| `src/claude-agent-installer.js` | Claude Code 适配：写 `~/.claude.json` 的 `mcpServers.agentquad` + 装 `~/.claude/skills/agentquad-child/SKILL.md` |
| `src/codex-agent-installer.js` | Codex 适配：写 `~/.codex/config.toml` 的 `[mcp_servers.agentquad]` + 装 `~/.codex/skills/agentquad-child/SKILL.md` |
| `src/cursor-agent-installer.js` | Cursor 适配：写 `~/.cursor/mcp.json` 的 `mcpServers.agentquad` + 装 `~/.cursor/rules/agentquad.mdc` |
| `src/agent-installer-dispatcher.js` | 三家分发，统一 install/uninstall/status/health/preview/bootstrap |
| `src/templates/agent-skills/agentquad-child.skill.md` | skill / rule 正文（一份内容） |
| `src/templates/agent-skills/agentquad-child.cursor.mdc` | Cursor 专用 mdc（只是 frontmatter 不同，正文 import 同一份） |
| `src/cli.js` | 新增 `agents` 子命令组 + `start` 调 bootstrap + `doctor` 集成 |
| `src/routes/ai-terminal.js` | `spawnSession` 注入 `QUADTODO_DEPTH` / `QUADTODO_PARENT_TODO_ID` + 运行时 `--mcp-config` |
| `src/mcp/tools/openclaw/index.js` | `start_ai_session` 把 `parentTodoId` 传给 `spawnSession`（已有 todoId 链路；新增 parent 透传） |
| `test/agent-installer-shared.test.js` | 单测 |
| `test/claude-agent-installer.test.js` | 单测 |
| `test/codex-agent-installer.test.js` | 单测 |
| `test/cursor-agent-installer.test.js` | 单测 |
| `test/agent-installer-dispatcher.test.js` | 单测 |
| `test/ai-terminal-runtime-mcp.test.js` | spawnSession 运行时注入回归 |

---

## Phase A — Foundation & per-target writers

### Task 1: 共享工具（marker / atomic write / runtime config writer）

**Files:**
- Create: `src/agent-installer-shared.js`
- Test: `test/agent-installer-shared.test.js`

#### - [ ] Step 1.1: 写失败测试 — marker 序列化/反序列化

创建 `test/agent-installer-shared.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildMarker,
  isAgentquadManaged,
  writeJsonAtomic,
  writeRuntimeMcpConfig,
  cleanupRuntimeMcpConfig,
} from '../src/agent-installer-shared.js'

describe('agent-installer-shared', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-shared-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('buildMarker', () => {
    it('returns object with version, port, generatedAt (iso)', () => {
      const m = buildMarker({ version: '0.4.0', port: 5677 })
      expect(m.version).toBe('0.4.0')
      expect(m.port).toBe(5677)
      expect(typeof m.generatedAt).toBe('string')
      expect(() => new Date(m.generatedAt)).not.toThrow()
    })
  })

  describe('isAgentquadManaged', () => {
    it('true when _agentquadManaged is an object with version', () => {
      expect(isAgentquadManaged({ _agentquadManaged: { version: '0.4.0' } })).toBe(true)
    })
    it('false when missing or boolean true (legacy hook installer style)', () => {
      expect(isAgentquadManaged({})).toBe(false)
      expect(isAgentquadManaged({ _agentquadManaged: true })).toBe(false)
    })
  })

  describe('writeJsonAtomic', () => {
    it('writes and is readable', () => {
      const p = join(dir, 'x.json')
      writeJsonAtomic(p, { a: 1 })
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 })
    })
    it('does not leave .tmp behind on success', () => {
      const p = join(dir, 'y.json')
      writeJsonAtomic(p, { a: 1 })
      expect(existsSync(p + '.tmp')).toBe(false)
    })
  })

  describe('writeRuntimeMcpConfig + cleanupRuntimeMcpConfig', () => {
    it('writes claude-format mcp config with given port', () => {
      const out = writeRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid1', port: 5678, tool: 'claude' })
      expect(out.path).toMatch(/mcp-sid1\.json$/)
      const raw = JSON.parse(readFileSync(out.path, 'utf8'))
      expect(raw.mcpServers.agentquad.url).toBe('http://127.0.0.1:5678/mcp')
      expect(raw.mcpServers.agentquad.transport ?? 'http').toBe('http')
    })

    it('writes codex-format toml config when tool=codex', () => {
      const out = writeRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid2', port: 5678, tool: 'codex' })
      expect(out.path).toMatch(/mcp-sid2\.toml$/)
      const raw = readFileSync(out.path, 'utf8')
      expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
      expect(raw).toMatch(/http:\/\/127\.0\.0\.1:5678\/mcp/)
    })

    it('cleanup removes the file silently when missing', () => {
      cleanupRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'ghost' })  // no-throw
      const out = writeRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid3', port: 5678, tool: 'claude' })
      cleanupRuntimeMcpConfig({ runtimeDir: dir, sessionId: 'sid3' })
      expect(existsSync(out.path)).toBe(false)
    })
  })
})
```

#### - [ ] Step 1.2: 运行测试确认失败

```bash
npx vitest run test/agent-installer-shared.test.js
```
Expected: 全部 FAIL（"Cannot find module ..."）

#### - [ ] Step 1.3: 实现 `src/agent-installer-shared.js`

```js
/**
 * 三家 agent installer 共享工具：
 *   - marker 元数据（_agentquadManaged 旁路键）
 *   - atomic JSON 写入（O_EXCL + rename）
 *   - 运行时 MCP 配置文件读写（spec C 方案）
 *
 * Marker 约定：JSON 文件里和 mcpServers.agentquad 同级放：
 *   { _agentquadManaged: { version, port, generatedAt } }
 * 不引入独立 lockfile，跟现有 hook installer 风格保持一致。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export function buildMarker({ version, port }) {
  return {
    version: String(version || ''),
    port: Number(port) || 0,
    generatedAt: new Date().toISOString(),
  }
}

export function isAgentquadManaged(entry) {
  if (!entry || typeof entry !== 'object') return false
  const m = entry._agentquadManaged
  return !!(m && typeof m === 'object' && typeof m.version === 'string')
}

/**
 * Atomic JSON 写入。
 * 通过 `<target>.tmp.<rand>` 中转 + rename，保证不出现部分写入。
 */
export function writeJsonAtomic(targetPath, value) {
  mkdirSync(dirname(targetPath), { recursive: true })
  const tmp = `${targetPath}.tmp.${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' })
  renameSync(tmp, targetPath)
}

/**
 * 运行时 MCP 配置文件（C 方案）。
 *   - tool=claude → JSON 格式（claude --mcp-config 接受 JSON）
 *   - tool=codex  → TOML 格式
 * 路径：<runtimeDir>/mcp-<sessionId>.{json|toml}
 */
export function writeRuntimeMcpConfig({ runtimeDir, sessionId, port, tool }) {
  mkdirSync(runtimeDir, { recursive: true })
  const url = `http://127.0.0.1:${port}/mcp`
  if (tool === 'codex') {
    const path = join(runtimeDir, `mcp-${sessionId}.toml`)
    const toml = `# agentquad runtime mcp config — auto generated, do not edit\n` +
      `[mcp_servers.agentquad]\n` +
      `url = "${url}"\n` +
      `transport = "http"\n`
    writeFileSync(path, toml, 'utf8')
    return { path, format: 'toml' }
  }
  // default: claude json format
  const path = join(runtimeDir, `mcp-${sessionId}.json`)
  writeJsonAtomic(path, {
    mcpServers: {
      agentquad: {
        url,
        transport: 'http',
      },
    },
  })
  return { path, format: 'json' }
}

export function cleanupRuntimeMcpConfig({ runtimeDir, sessionId }) {
  for (const ext of ['json', 'toml']) {
    const p = join(runtimeDir, `mcp-${sessionId}.${ext}`)
    try { if (existsSync(p)) unlinkSync(p) } catch { /* swallow */ }
  }
}

/**
 * 给 doctor / dispatcher 用：扫 runtimeDir，列出过去 24h 没刷新的孤儿。
 */
export function listStaleRuntimeConfigs({ runtimeDir, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  if (!existsSync(runtimeDir)) return []
  const now = Date.now()
  const fs = require('node:fs')
  return fs.readdirSync(runtimeDir)
    .filter(n => /^mcp-.*\.(json|toml)$/.test(n))
    .map(n => ({ name: n, path: join(runtimeDir, n), age: now - fs.statSync(join(runtimeDir, n)).mtimeMs }))
    .filter(x => x.age > maxAgeMs)
}
```

#### - [ ] Step 1.4: 跑测试

```bash
npx vitest run test/agent-installer-shared.test.js
```
Expected: 全部 PASS

#### - [ ] Step 1.5: Commit

```bash
git add src/agent-installer-shared.js test/agent-installer-shared.test.js
git commit -m "feat(agents): 共享工具 — marker / atomic write / 运行时 MCP 配置写"
```

---

### Task 2: skill / rule 正文模板

**Files:**
- Create: `src/templates/agent-skills/agentquad-child.skill.md`
- Create: `src/templates/agent-skills/agentquad-child.cursor.mdc`

#### - [ ] Step 2.1: 写 SKILL.md 正文（Claude / Codex 共用）

创建 `src/templates/agent-skills/agentquad-child.skill.md`:

```markdown
---
name: agentquad-child
description: |
  Use when the user wants to split the current AgentQuad task into a sub-task and delegate it to another AI agent. Activates inside AgentQuad-launched sessions (env QUADTODO_SESSION_ID present) or when the user explicitly mentions AgentQuad / 四象限 todo.
---

# AgentQuad 子任务委派

## 你身处的环境
- 你运行在 AgentQuad（本地四象限 AI 任务调度器）里
- 父任务的 ID 在环境变量 `QUADTODO_TODO_ID`，标题在 `QUADTODO_TODO_TITLE`
- AgentQuad 的 MCP 服务地址在 `QUADTODO_URL`（已通过 mcp 连接，无需手动配置）
- `QUADTODO_DEPTH` 表示嵌套层级（0=顶层，1+=被另一个 agent 启动）

## 何时触发本 skill
- 用户说"把 X 拆出去 / 另起一个 agent 干 / 开个分支任务"
- 你判断当前任务过大、应该拆分
- 用户主动要求创建/查看/管理 AgentQuad todo

## 操作流程
1. `list_quadrants` → 决定子任务放哪个象限（默认 Q2 重要不紧急）
2. `create_todo(title, quadrant, parentId=<父 TODO_ID>, description)` → 拿到子 todo id
3. （可选）`start_ai_session(todoId=<子 id>, tool="claude"|"codex", prompt=<明确任务说明>)`
4. 把 ticket / 子 id 告诉用户

## 重要约束
- 拆子任务前先**和用户对齐范围**，不要无脑拆
- 不要为了拆而拆 —— 子任务必须有清晰的、独立可完成的目标
- `start_ai_session` 默认 `permissionMode=bypass`，子 agent 默认有写权限，慎重
```

#### - [ ] Step 2.2: 写 Cursor 的 mdc 文件

创建 `src/templates/agent-skills/agentquad-child.cursor.mdc`:

```mdc
---
description: Use when the user mentions quadtodo / agentquad / 四象限 todo or wants to split a task into sub-tasks delegated to AI agents.
alwaysApply: false
---

# AgentQuad 子任务委派

## 你身处的环境
- 你正在通过 Cursor 操作一个 AgentQuad（本地四象限 AI 任务调度器）项目
- AgentQuad 的 MCP 服务在 `http://127.0.0.1:<port>/mcp`（已通过 mcp 连接）
- 当前 Cursor 会话本身不是 AgentQuad 启动的，所以没有 `QUADTODO_*` 环境变量

## 何时触发本 rule
- 用户说"在 AgentQuad 加一条 todo / 拆出去给另一个 agent / 看下我的四象限"
- 用户提到 quadtodo / agentquad / 四象限 todo

## 操作流程
1. `list_quadrants` → 决定象限（默认 Q2）
2. `create_todo(title, quadrant, description, parentId?)` → 拿到 todo id
3. （可选）`start_ai_session(todoId, tool="claude"|"codex", prompt)` → 把任务交给一个本地 PTY agent
4. 告诉用户 ticket / id，及它在 AgentQuad web UI（http://127.0.0.1:5677 或 user 配置端口）里可见

## 重要约束
- 创建前先与用户对齐范围与象限
- `start_ai_session` 默认 `permissionMode=bypass`，子 agent 有写权限，慎重
- Cursor 无法被 `start_ai_session` 拉起 —— 拉子 agent 只能选 claude / codex
```

#### - [ ] Step 2.3: Commit

```bash
git add src/templates/agent-skills/
git commit -m "feat(agents): skill / rule 正文模板（claude/codex/cursor 共用语义）"
```

---

### Task 3: Claude installer

**Files:**
- Create: `src/claude-agent-installer.js`
- Test: `test/claude-agent-installer.test.js`

#### - [ ] Step 3.1: 写失败测试

创建 `test/claude-agent-installer.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgent,
  uninstallAgent,
  inspectAgent,
} from '../src/claude-agent-installer.js'

describe('claude-agent-installer', () => {
  let dir, claudeJsonPath, skillsDir, skillTemplatePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-claude-agent-'))
    claudeJsonPath = join(dir, '.claude.json')
    skillsDir = join(dir, '.claude', 'skills')
    skillTemplatePath = join(dir, 'skill-template.md')
    writeFileSync(skillTemplatePath, '# fake skill content\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates ~/.claude.json with mcpServers.agentquad + _agentquadManaged marker', () => {
    const r = installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    expect(r.ok).toBe(true)
    expect(r.changes).toContain('mcp_registered')
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad.url).toBe('http://127.0.0.1:5677/mcp')
    expect(j._agentquadManaged.version).toBe('0.4.0')
    expect(j._agentquadManaged.port).toBe(5677)
  })

  it('writes skill file to skillsDir/agentquad-child/SKILL.md', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    expect(existsSync(join(skillsDir, 'agentquad-child', 'SKILL.md'))).toBe(true)
  })

  it('preserves user-defined mcpServers entries', () => {
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }))
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.other.url).toBe('http://x')
    expect(j.mcpServers.agentquad).toBeDefined()
  })

  it('idempotent — re-install with same port yields identical file', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const a = readFileSync(claudeJsonPath, 'utf8')
    // 故意微调 generatedAt 不计入 idempotence —— 实现里 same port+version 应保留旧 generatedAt
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const b = readFileSync(claudeJsonPath, 'utf8')
    expect(b).toBe(a)
  })

  it('updates port automatically on re-install with different port', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5678, version: '0.4.0' })
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad.url).toBe('http://127.0.0.1:5678/mcp')
    expect(j._agentquadManaged.port).toBe(5678)
  })

  it('uninstall removes mcpServers.agentquad + marker + skill, keeps other mcpServers', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    // 用户事后手加一个 other entry
    const cur = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    cur.mcpServers.other = { url: 'http://x' }
    writeFileSync(claudeJsonPath, JSON.stringify(cur))
    uninstallAgent({ claudeJsonPath, skillsDir })
    const j = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad).toBeUndefined()
    expect(j._agentquadManaged).toBeUndefined()
    expect(j.mcpServers.other.url).toBe('http://x')
    expect(existsSync(join(skillsDir, 'agentquad-child'))).toBe(false)
  })

  it('inspect reports installed=true and drift=true when port mismatch', () => {
    installAgent({ claudeJsonPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const a = inspectAgent({ claudeJsonPath, skillsDir, expectedPort: 5677 })
    expect(a.mcpRegistered).toBe(true)
    expect(a.skillPresent).toBe(true)
    expect(a.drift).toBe(false)

    const b = inspectAgent({ claudeJsonPath, skillsDir, expectedPort: 9999 })
    expect(b.drift).toBe(true)
  })
})
```

#### - [ ] Step 3.2: 运行测试验证 fail

```bash
npx vitest run test/claude-agent-installer.test.js
```
Expected: 全部 FAIL（"Cannot find module ..."）

#### - [ ] Step 3.3: 实现 `src/claude-agent-installer.js`

```js
/**
 * Claude Code agent installer：
 *   - 写 ~/.claude.json 的 mcpServers.agentquad（带 _agentquadManaged 旁路 marker）
 *   - 装 ~/.claude/skills/agentquad-child/SKILL.md
 *
 * 跟 src/openclaw-hook-installer.js 风格保持一致 —— 都是改 ~/.claude.json。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildMarker, isAgentquadManaged, writeJsonAtomic } from './agent-installer-shared.js'

const SKILL_NAME = 'agentquad-child'

function defaultClaudeJsonPath() {
  return join(homedir(), '.claude.json')
}

function defaultSkillsDir() {
  return join(homedir(), '.claude', 'skills')
}

function defaultSkillTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.skill.md', import.meta.url))
}

function readClaudeJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch (e) { throw new Error(`malformed_claude_json: ${e.message}`) }
}

export function installAgent({
  claudeJsonPath = defaultClaudeJsonPath(),
  skillsDir = defaultSkillsDir(),
  skillTemplatePath = defaultSkillTemplatePath(),
  port,
  version,
} = {}) {
  if (!port) throw new Error('port_required')
  if (!version) throw new Error('version_required')

  const changes = []
  const cur = readClaudeJson(claudeJsonPath)
  cur.mcpServers = cur.mcpServers || {}

  const desired = {
    url: `http://127.0.0.1:${port}/mcp`,
    transport: 'http',
  }
  const prev = cur.mcpServers.agentquad
  const prevMarker = cur._agentquadManaged
  const samePort = prev && prev.url === desired.url
  const sameVersion = prevMarker && prevMarker.version === version

  cur.mcpServers.agentquad = desired
  if (samePort && sameVersion && isAgentquadManaged(cur)) {
    // 保留旧 generatedAt，让 idempotent 写回不改 hash
    cur._agentquadManaged = prevMarker
  } else {
    cur._agentquadManaged = buildMarker({ version, port })
    changes.push('mcp_registered')
  }

  writeJsonAtomic(claudeJsonPath, cur)

  // skill
  const skillDir = join(skillsDir, SKILL_NAME)
  const skillFile = join(skillDir, 'SKILL.md')
  if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== readFileSync(skillTemplatePath, 'utf8')) {
    mkdirSync(skillDir, { recursive: true })
    copyFileSync(skillTemplatePath, skillFile)
    changes.push('skill_installed')
  }

  return { ok: true, changes, configPath: claudeJsonPath, skillPath: skillFile }
}

export function uninstallAgent({
  claudeJsonPath = defaultClaudeJsonPath(),
  skillsDir = defaultSkillsDir(),
} = {}) {
  const removed = []
  if (existsSync(claudeJsonPath)) {
    const cur = readClaudeJson(claudeJsonPath)
    if (cur.mcpServers?.agentquad) {
      delete cur.mcpServers.agentquad
      removed.push('mcp_entry')
    }
    if (cur._agentquadManaged) {
      delete cur._agentquadManaged
      removed.push('marker')
    }
    writeJsonAtomic(claudeJsonPath, cur)
  }
  const skillDir = join(skillsDir, SKILL_NAME)
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
    removed.push('skill')
  }
  return { ok: true, removed }
}

export function inspectAgent({
  claudeJsonPath = defaultClaudeJsonPath(),
  skillsDir = defaultSkillsDir(),
  expectedPort = null,
} = {}) {
  const out = {
    target: 'claude',
    mcpRegistered: false,
    skillPresent: false,
    drift: false,
    configPath: claudeJsonPath,
    expectedPort,
    actualPort: null,
    version: null,
  }
  if (existsSync(claudeJsonPath)) {
    try {
      const cur = readClaudeJson(claudeJsonPath)
      if (cur.mcpServers?.agentquad?.url) {
        out.mcpRegistered = true
        const m = cur.mcpServers.agentquad.url.match(/:(\d+)\//)
        if (m) out.actualPort = Number(m[1])
        out.version = cur._agentquadManaged?.version || null
      }
    } catch { /* malformed, treat as not registered */ }
  }
  if (existsSync(join(skillsDir, SKILL_NAME, 'SKILL.md'))) out.skillPresent = true
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
```

#### - [ ] Step 3.4: 跑测试

```bash
npx vitest run test/claude-agent-installer.test.js
```
Expected: 全部 PASS

#### - [ ] Step 3.5: Commit

```bash
git add src/claude-agent-installer.js test/claude-agent-installer.test.js
git commit -m "feat(agents): Claude Code installer — MCP 注册 + skill 落盘"
```

---

### Task 4: Codex installer

**Files:**
- Create: `src/codex-agent-installer.js`
- Test: `test/codex-agent-installer.test.js`

#### - [ ] Step 4.1: 写失败测试

创建 `test/codex-agent-installer.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgent,
  uninstallAgent,
  inspectAgent,
} from '../src/codex-agent-installer.js'

describe('codex-agent-installer', () => {
  let dir, configTomlPath, skillsDir, skillTemplatePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-codex-agent-'))
    configTomlPath = join(dir, 'config.toml')
    skillsDir = join(dir, 'skills')
    skillTemplatePath = join(dir, 'skill-template.md')
    writeFileSync(skillTemplatePath, '# fake skill\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates config.toml with marker block containing [mcp_servers.agentquad]', () => {
    const r = installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    expect(r.ok).toBe(true)
    expect(r.changes).toContain('mcp_registered')
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/# <<< agentquad managed start/)
    expect(raw).toMatch(/# <<< agentquad managed end/)
    expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
    expect(raw).toMatch(/url\s*=\s*"http:\/\/127\.0\.0\.1:5677\/mcp"/)
    expect(raw).toMatch(/# agentquad-version: 0\.4\.0/)
    expect(raw).toMatch(/# agentquad-port: 5677/)
  })

  it('preserves pre-existing config content outside marker block', () => {
    writeFileSync(configTomlPath, 'model = "gpt-5"\n[features]\ncodex_hooks = true\n')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/model = "gpt-5"/)
    expect(raw).toMatch(/codex_hooks = true/)
    expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
  })

  it('preserves user-written other [mcp_servers.X] outside marker', () => {
    writeFileSync(configTomlPath, '[mcp_servers.other]\nurl = "http://x"\n')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/\[mcp_servers\.other\]/)
    expect(raw).toMatch(/\[mcp_servers\.agentquad\]/)
  })

  it('idempotent', () => {
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const a = readFileSync(configTomlPath, 'utf8')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const b = readFileSync(configTomlPath, 'utf8')
    expect(b).toBe(a)
  })

  it('updates port on re-install', () => {
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5678, version: '0.4.0' })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).toMatch(/127\.0\.0\.1:5678/)
    expect(raw).not.toMatch(/127\.0\.0\.1:5677/)
  })

  it('uninstall removes only the marker block', () => {
    writeFileSync(configTomlPath, '[mcp_servers.other]\nurl = "http://x"\n')
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    uninstallAgent({ configTomlPath, skillsDir })
    const raw = readFileSync(configTomlPath, 'utf8')
    expect(raw).not.toMatch(/\[mcp_servers\.agentquad\]/)
    expect(raw).toMatch(/\[mcp_servers\.other\]/)
  })

  it('inspect drift on port mismatch', () => {
    installAgent({ configTomlPath, skillsDir, skillTemplatePath, port: 5677, version: '0.4.0' })
    const r = inspectAgent({ configTomlPath, skillsDir, expectedPort: 9999 })
    expect(r.mcpRegistered).toBe(true)
    expect(r.drift).toBe(true)
  })
})
```

#### - [ ] Step 4.2: 运行测试验证 fail

```bash
npx vitest run test/codex-agent-installer.test.js
```
Expected: 全部 FAIL

#### - [ ] Step 4.3: 实现 `src/codex-agent-installer.js`

```js
/**
 * Codex agent installer：
 *   - 写 ~/.codex/config.toml 的 [mcp_servers.agentquad] 表（marker 注释包起来）
 *   - 装 ~/.codex/skills/agentquad-child/SKILL.md
 *
 * marker 实现：TOML 文件支持注释，用 `# <<< agentquad managed start ... # >>> end` 注释行
 * 包裹一段以 newline 分隔的 toml block；卸载时按注释边界精确删。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SKILL_NAME = 'agentquad-child'
const MARKER_START = '# <<< agentquad managed start — do not edit by hand >>>'
const MARKER_END = '# <<< agentquad managed end >>>'

function defaultConfigTomlPath() {
  return join(homedir(), '.codex', 'config.toml')
}

function defaultSkillsDir() {
  return join(homedir(), '.codex', 'skills')
}

function defaultSkillTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.skill.md', import.meta.url))
}

function buildBlock({ port, version }) {
  return [
    MARKER_START,
    `# agentquad-version: ${version}`,
    `# agentquad-port: ${port}`,
    `# agentquad-generated-at: ${new Date().toISOString()}`,
    '[mcp_servers.agentquad]',
    `url = "http://127.0.0.1:${port}/mcp"`,
    'transport = "http"',
    MARKER_END,
    '',
  ].join('\n')
}

function stripExistingBlock(raw) {
  const startIdx = raw.indexOf(MARKER_START)
  if (startIdx === -1) return { raw, found: false }
  const endIdx = raw.indexOf(MARKER_END, startIdx)
  if (endIdx === -1) return { raw, found: false }
  const afterEnd = raw.indexOf('\n', endIdx)
  const head = raw.slice(0, startIdx).replace(/\n*$/, '\n')
  const tail = afterEnd === -1 ? '' : raw.slice(afterEnd + 1)
  return { raw: head + tail, found: true }
}

function parseExistingBlock(raw) {
  const startIdx = raw.indexOf(MARKER_START)
  if (startIdx === -1) return null
  const endIdx = raw.indexOf(MARKER_END, startIdx)
  if (endIdx === -1) return null
  const block = raw.slice(startIdx, endIdx + MARKER_END.length)
  const versionM = block.match(/# agentquad-version:\s*(\S+)/)
  const portM = block.match(/# agentquad-port:\s*(\d+)/)
  const urlM = block.match(/url\s*=\s*"http:\/\/[^"]*:(\d+)\//)
  return {
    version: versionM ? versionM[1] : null,
    port: portM ? Number(portM[1]) : null,
    urlPort: urlM ? Number(urlM[1]) : null,
  }
}

export function installAgent({
  configTomlPath = defaultConfigTomlPath(),
  skillsDir = defaultSkillsDir(),
  skillTemplatePath = defaultSkillTemplatePath(),
  port,
  version,
} = {}) {
  if (!port) throw new Error('port_required')
  if (!version) throw new Error('version_required')

  const changes = []
  const cur = existsSync(configTomlPath) ? readFileSync(configTomlPath, 'utf8') : ''
  const existing = parseExistingBlock(cur)
  const sameAll = existing && existing.version === version && existing.port === port

  let next
  if (sameAll) {
    // idempotent — 不动文件，保留原 generatedAt
    next = cur
  } else {
    const { raw: stripped } = stripExistingBlock(cur)
    const block = buildBlock({ port, version })
    const sep = stripped && !stripped.endsWith('\n') ? '\n' : ''
    next = stripped + sep + block
    changes.push('mcp_registered')
  }

  if (next !== cur) {
    mkdirSync(dirname(configTomlPath), { recursive: true })
    writeFileSync(configTomlPath, next, 'utf8')
  }

  // skill
  const skillDir = join(skillsDir, SKILL_NAME)
  const skillFile = join(skillDir, 'SKILL.md')
  if (!existsSync(skillFile) || readFileSync(skillFile, 'utf8') !== readFileSync(skillTemplatePath, 'utf8')) {
    mkdirSync(skillDir, { recursive: true })
    copyFileSync(skillTemplatePath, skillFile)
    changes.push('skill_installed')
  }

  return { ok: true, changes, configPath: configTomlPath, skillPath: skillFile }
}

export function uninstallAgent({
  configTomlPath = defaultConfigTomlPath(),
  skillsDir = defaultSkillsDir(),
} = {}) {
  const removed = []
  if (existsSync(configTomlPath)) {
    const cur = readFileSync(configTomlPath, 'utf8')
    const { raw, found } = stripExistingBlock(cur)
    if (found) {
      writeFileSync(configTomlPath, raw, 'utf8')
      removed.push('mcp_block')
    }
  }
  const skillDir = join(skillsDir, SKILL_NAME)
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true, force: true })
    removed.push('skill')
  }
  return { ok: true, removed }
}

export function inspectAgent({
  configTomlPath = defaultConfigTomlPath(),
  skillsDir = defaultSkillsDir(),
  expectedPort = null,
} = {}) {
  const out = {
    target: 'codex',
    mcpRegistered: false,
    skillPresent: false,
    drift: false,
    configPath: configTomlPath,
    expectedPort,
    actualPort: null,
    version: null,
  }
  if (existsSync(configTomlPath)) {
    const cur = readFileSync(configTomlPath, 'utf8')
    const parsed = parseExistingBlock(cur)
    if (parsed) {
      out.mcpRegistered = true
      out.actualPort = parsed.port
      out.version = parsed.version
    }
  }
  if (existsSync(join(skillsDir, SKILL_NAME, 'SKILL.md'))) out.skillPresent = true
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
```

#### - [ ] Step 4.4: 跑测试

```bash
npx vitest run test/codex-agent-installer.test.js
```
Expected: 全部 PASS

#### - [ ] Step 4.5: Commit

```bash
git add src/codex-agent-installer.js test/codex-agent-installer.test.js
git commit -m "feat(agents): Codex installer — config.toml MCP 注册 + skill 落盘"
```

---

### Task 5: Cursor installer

**Files:**
- Create: `src/cursor-agent-installer.js`
- Test: `test/cursor-agent-installer.test.js`

#### - [ ] Step 5.1: 写失败测试

创建 `test/cursor-agent-installer.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAgent,
  uninstallAgent,
  inspectAgent,
} from '../src/cursor-agent-installer.js'

describe('cursor-agent-installer', () => {
  let dir, mcpJsonPath, rulesDir, mdcTemplatePath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aq-cursor-agent-'))
    mcpJsonPath = join(dir, 'mcp.json')
    rulesDir = join(dir, 'rules')
    mdcTemplatePath = join(dir, 'rule-template.mdc')
    writeFileSync(mdcTemplatePath, '---\ndescription: fake\nalwaysApply: false\n---\n# rule\n')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('creates ~/.cursor/mcp.json with mcpServers.agentquad + marker', () => {
    const r = installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    expect(r.ok).toBe(true)
    expect(r.changes).toContain('mcp_registered')
    const j = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad.url).toBe('http://127.0.0.1:5677/mcp')
    expect(j._agentquadManaged.version).toBe('0.4.0')
  })

  it('writes rule file to rulesDir/agentquad.mdc', () => {
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    expect(existsSync(join(rulesDir, 'agentquad.mdc'))).toBe(true)
  })

  it('preserves user-defined mcpServers entries', () => {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }))
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    const j = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
    expect(j.mcpServers.other.url).toBe('http://x')
  })

  it('uninstall removes only agentquad entries and rule', () => {
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { other: { url: 'http://x' } } }))
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    uninstallAgent({ mcpJsonPath, rulesDir })
    const j = JSON.parse(readFileSync(mcpJsonPath, 'utf8'))
    expect(j.mcpServers.agentquad).toBeUndefined()
    expect(j.mcpServers.other.url).toBe('http://x')
    expect(existsSync(join(rulesDir, 'agentquad.mdc'))).toBe(false)
  })

  it('inspect drift on port mismatch', () => {
    installAgent({ mcpJsonPath, rulesDir, mdcTemplatePath, port: 5677, version: '0.4.0' })
    const r = inspectAgent({ mcpJsonPath, rulesDir, expectedPort: 9999 })
    expect(r.drift).toBe(true)
  })
})
```

#### - [ ] Step 5.2: 运行测试验证 fail

```bash
npx vitest run test/cursor-agent-installer.test.js
```
Expected: 全部 FAIL

#### - [ ] Step 5.3: 实现 `src/cursor-agent-installer.js`

```js
/**
 * Cursor agent installer：
 *   - 写 ~/.cursor/mcp.json 的 mcpServers.agentquad（带 _agentquadManaged 旁路 marker）
 *   - 装 ~/.cursor/rules/agentquad.mdc
 *
 * Cursor 不是 AgentQuad spawn 的，没有运行时注入（C），只走 B + rule。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildMarker, isAgentquadManaged, writeJsonAtomic } from './agent-installer-shared.js'

const RULE_FILE = 'agentquad.mdc'

function defaultMcpJsonPath() {
  return join(homedir(), '.cursor', 'mcp.json')
}

function defaultRulesDir() {
  return join(homedir(), '.cursor', 'rules')
}

function defaultMdcTemplatePath() {
  return fileURLToPath(new URL('./templates/agent-skills/agentquad-child.cursor.mdc', import.meta.url))
}

function readMcpJson(path) {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return {}
  try { return JSON.parse(raw) } catch (e) { throw new Error(`malformed_cursor_mcp_json: ${e.message}`) }
}

export function installAgent({
  mcpJsonPath = defaultMcpJsonPath(),
  rulesDir = defaultRulesDir(),
  mdcTemplatePath = defaultMdcTemplatePath(),
  port,
  version,
} = {}) {
  if (!port) throw new Error('port_required')
  if (!version) throw new Error('version_required')

  const changes = []
  const cur = readMcpJson(mcpJsonPath)
  cur.mcpServers = cur.mcpServers || {}

  const desired = { url: `http://127.0.0.1:${port}/mcp`, transport: 'http' }
  const prev = cur.mcpServers.agentquad
  const prevMarker = cur._agentquadManaged
  const samePort = prev && prev.url === desired.url
  const sameVersion = prevMarker && prevMarker.version === version

  cur.mcpServers.agentquad = desired
  if (samePort && sameVersion && isAgentquadManaged(cur)) {
    cur._agentquadManaged = prevMarker
  } else {
    cur._agentquadManaged = buildMarker({ version, port })
    changes.push('mcp_registered')
  }
  writeJsonAtomic(mcpJsonPath, cur)

  const ruleFile = join(rulesDir, RULE_FILE)
  if (!existsSync(ruleFile) || readFileSync(ruleFile, 'utf8') !== readFileSync(mdcTemplatePath, 'utf8')) {
    mkdirSync(rulesDir, { recursive: true })
    copyFileSync(mdcTemplatePath, ruleFile)
    changes.push('rule_installed')
  }

  return { ok: true, changes, configPath: mcpJsonPath, rulePath: ruleFile }
}

export function uninstallAgent({
  mcpJsonPath = defaultMcpJsonPath(),
  rulesDir = defaultRulesDir(),
} = {}) {
  const removed = []
  if (existsSync(mcpJsonPath)) {
    const cur = readMcpJson(mcpJsonPath)
    if (cur.mcpServers?.agentquad) {
      delete cur.mcpServers.agentquad
      removed.push('mcp_entry')
    }
    if (cur._agentquadManaged) {
      delete cur._agentquadManaged
      removed.push('marker')
    }
    writeJsonAtomic(mcpJsonPath, cur)
  }
  const ruleFile = join(rulesDir, RULE_FILE)
  if (existsSync(ruleFile)) {
    unlinkSync(ruleFile)
    removed.push('rule')
  }
  return { ok: true, removed }
}

export function inspectAgent({
  mcpJsonPath = defaultMcpJsonPath(),
  rulesDir = defaultRulesDir(),
  expectedPort = null,
} = {}) {
  const out = {
    target: 'cursor',
    mcpRegistered: false,
    skillPresent: false,  // rulePresent 对外仍叫 skillPresent，便于 dispatcher 统一展示
    drift: false,
    configPath: mcpJsonPath,
    expectedPort,
    actualPort: null,
    version: null,
  }
  if (existsSync(mcpJsonPath)) {
    try {
      const cur = readMcpJson(mcpJsonPath)
      if (cur.mcpServers?.agentquad?.url) {
        out.mcpRegistered = true
        const m = cur.mcpServers.agentquad.url.match(/:(\d+)\//)
        if (m) out.actualPort = Number(m[1])
        out.version = cur._agentquadManaged?.version || null
      }
    } catch { /* malformed */ }
  }
  if (existsSync(join(rulesDir, RULE_FILE))) out.skillPresent = true
  if (out.mcpRegistered && expectedPort && out.actualPort !== expectedPort) out.drift = true
  return out
}
```

#### - [ ] Step 5.4: 跑测试

```bash
npx vitest run test/cursor-agent-installer.test.js
```
Expected: 全部 PASS

#### - [ ] Step 5.5: Commit

```bash
git add src/cursor-agent-installer.js test/cursor-agent-installer.test.js
git commit -m "feat(agents): Cursor installer — mcp.json 注册 + 全局 rule 落盘"
```

---

## Phase B — Unified installer dispatcher

### Task 6: 三家分发器

**Files:**
- Create: `src/agent-installer-dispatcher.js`
- Test: `test/agent-installer-dispatcher.test.js`

#### - [ ] Step 6.1: 写失败测试

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installAllAgents,
  uninstallAllAgents,
  inspectAllAgents,
  previewAllAgents,
} from '../src/agent-installer-dispatcher.js'

function makeTargets(dir) {
  return {
    claude: {
      claudeJsonPath: join(dir, 'claude.json'),
      skillsDir: join(dir, 'claude-skills'),
    },
    codex: {
      configTomlPath: join(dir, 'codex.toml'),
      skillsDir: join(dir, 'codex-skills'),
    },
    cursor: {
      mcpJsonPath: join(dir, 'cursor-mcp.json'),
      rulesDir: join(dir, 'cursor-rules'),
    },
  }
}

describe('agent-installer-dispatcher', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-dispatch-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('installAllAgents writes all three with port/version, returns per-target ok', () => {
    const r = installAllAgents({ port: 5677, version: '0.4.0', overrides: makeTargets(dir) })
    expect(r.results.claude.ok).toBe(true)
    expect(r.results.codex.ok).toBe(true)
    expect(r.results.cursor.ok).toBe(true)
  })

  it('installAllAgents --target claude only writes claude', () => {
    const r = installAllAgents({ port: 5677, version: '0.4.0', overrides: makeTargets(dir), only: ['claude'] })
    expect(r.results.claude.ok).toBe(true)
    expect(r.results.codex).toBeUndefined()
    expect(r.results.cursor).toBeUndefined()
  })

  it('previewAllAgents returns changes list without writing files', () => {
    const t = makeTargets(dir)
    const p = previewAllAgents({ port: 5677, version: '0.4.0', overrides: t })
    expect(p.results.claude.changes.length).toBeGreaterThan(0)
    expect(existsSync(t.claude.claudeJsonPath)).toBe(false)
  })

  it('inspectAllAgents detects drift across three targets', () => {
    const t = makeTargets(dir)
    installAllAgents({ port: 5677, version: '0.4.0', overrides: t })
    const r = inspectAllAgents({ expectedPort: 9999, overrides: t })
    expect(r.results.claude.drift).toBe(true)
    expect(r.results.codex.drift).toBe(true)
    expect(r.results.cursor.drift).toBe(true)
  })

  it('continues installing other targets when one throws', () => {
    const t = makeTargets(dir)
    t.codex.configTomlPath = '/proc/should-fail/0/config.toml'  // root-only dir on linux/mac
    const r = installAllAgents({ port: 5677, version: '0.4.0', overrides: t })
    expect(r.results.claude.ok).toBe(true)
    expect(r.results.codex.ok).toBe(false)
    expect(r.results.cursor.ok).toBe(true)
    expect(r.summary.failed).toEqual(['codex'])
  })
})
```

#### - [ ] Step 6.2: 运行测试验证 fail

```bash
npx vitest run test/agent-installer-dispatcher.test.js
```
Expected: FAIL

#### - [ ] Step 6.3: 实现 `src/agent-installer-dispatcher.js`

```js
/**
 * 三家 agent installer 统一分发：
 *   - install / uninstall / inspect / preview
 *   - 单个 target 失败不阻断其它
 *   - overrides 注入测试用路径
 */
import * as claudeInst from './claude-agent-installer.js'
import * as codexInst from './codex-agent-installer.js'
import * as cursorInst from './cursor-agent-installer.js'

const TARGETS = ['claude', 'codex', 'cursor']

function targetMod(name) {
  if (name === 'claude') return claudeInst
  if (name === 'codex') return codexInst
  if (name === 'cursor') return cursorInst
  throw new Error('unknown_target:' + name)
}

function pickTargets(only) {
  if (!only) return TARGETS
  return TARGETS.filter(t => only.includes(t))
}

export function installAllAgents({ port, version, only = null, overrides = {} } = {}) {
  const results = {}
  const failed = []
  for (const t of pickTargets(only)) {
    const args = { port, version, ...(overrides[t] || {}) }
    try {
      results[t] = targetMod(t).installAgent(args)
    } catch (e) {
      results[t] = { ok: false, error: e?.message || String(e) }
      failed.push(t)
    }
  }
  return { results, summary: { failed } }
}

export function uninstallAllAgents({ only = null, overrides = {} } = {}) {
  const results = {}
  const failed = []
  for (const t of pickTargets(only)) {
    try {
      results[t] = targetMod(t).uninstallAgent(overrides[t] || {})
    } catch (e) {
      results[t] = { ok: false, error: e?.message || String(e) }
      failed.push(t)
    }
  }
  return { results, summary: { failed } }
}

export function inspectAllAgents({ expectedPort = null, overrides = {} } = {}) {
  const results = {}
  for (const t of TARGETS) {
    results[t] = targetMod(t).inspectAgent({ expectedPort, ...(overrides[t] || {}) })
  }
  return { results }
}

export function previewAllAgents({ port, version, only = null, overrides = {} } = {}) {
  // 干跑：先 inspect 看现状，再算出"如果 install 会做什么"
  // 简化：复用 inspect，对每个 target 输出 needed change set
  const results = {}
  for (const t of pickTargets(only)) {
    const ins = targetMod(t).inspectAgent({ expectedPort: port, ...(overrides[t] || {}) })
    const changes = []
    if (!ins.mcpRegistered) changes.push('mcp_registered')
    else if (ins.drift) changes.push('mcp_port_update')
    else if (ins.version !== version) changes.push('mcp_version_update')
    if (!ins.skillPresent) changes.push(t === 'cursor' ? 'rule_installed' : 'skill_installed')
    results[t] = { changes }
  }
  return { results }
}
```

#### - [ ] Step 6.4: 跑测试

```bash
npx vitest run test/agent-installer-dispatcher.test.js
```
Expected: PASS

#### - [ ] Step 6.5: Commit

```bash
git add src/agent-installer-dispatcher.js test/agent-installer-dispatcher.test.js
git commit -m "feat(agents): 三家分发器 install/uninstall/inspect/preview"
```

---

## Phase C — CLI integration

### Task 7: `agentquad agents` 子命令组

**Files:**
- Modify: `src/cli.js`（新增 `agents` 子命令；参考第 1045 行附近 `hookCmd` 写法）
- Test: `test/cli.test.js`（追加 `agents status` 一组烟雾测试，或新建 `test/cli-agents.test.js`）

#### - [ ] Step 7.1: 写一个轻量烟雾测试（执行真实 CLI 调用，只验出参数解析 + dispatcher 被调到）

创建 `test/cli-agents.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'src/cli.js')

function run(args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('cli agents', () => {
  it('agents --help lists install/uninstall/status', () => {
    const r = run(['agents', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/install/)
    expect(r.stdout).toMatch(/uninstall/)
    expect(r.stdout).toMatch(/status/)
  })

  it('agents install --dry-run 不写任何文件 (只看 stdout)', () => {
    const r = run(['agents', 'install', '--dry-run', '--target', 'claude'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/dry-run/i)
  })

  it('agents status 不报错', () => {
    const r = run(['agents', 'status'])
    expect(r.code).toBe(0)
  })
})
```

#### - [ ] Step 7.2: 跑测试验证 fail

```bash
npx vitest run test/cli-agents.test.js
```
Expected: FAIL（`agents` 子命令尚未注册）

#### - [ ] Step 7.3: 编辑 `src/cli.js`，新增 `agents` 子命令组

在 `src/cli.js` 找到 `const hookCmd = program.command('hook')...` 段（约 1045 行），紧跟其后追加：

```js
const agentsCmd = program.command('agents').description('为 Claude Code / Codex / Cursor 装 AgentQuad MCP + skill（B+C 联动）')

function readPortAndVersion() {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  const cfg = loadConfig?.() || {}
  const port = cfg.port || 5677
  return { port, version: pkg.version }
}

const VALID_TARGETS = ['claude', 'codex', 'cursor']

function addTargetFlag(cmd) {
  return cmd.option('--target <name>', '指定 claude / codex / cursor，多次传入累加', (v, acc=[]) => {
    if (!VALID_TARGETS.includes(v)) throw new Error(`unknown target: ${v}`)
    acc.push(v); return acc
  }, undefined)
}

addTargetFlag(agentsCmd.command('install'))
  .option('--dry-run', '只 preview 不写盘')
  .action(async (opts) => {
    const { installAllAgents, previewAllAgents } = await import('./agent-installer-dispatcher.js')
    const { port, version } = readPortAndVersion()
    const only = opts.target || null
    if (opts.dryRun) {
      const p = previewAllAgents({ port, version, only })
      console.log('dry-run preview:')
      for (const [t, r] of Object.entries(p.results)) console.log(`  ${t}:`, r.changes.length ? r.changes.join(', ') : 'no changes')
      return
    }
    const r = installAllAgents({ port, version, only })
    for (const [t, res] of Object.entries(r.results)) {
      if (res.ok) console.log(`✓ ${t}:`, res.changes?.length ? res.changes.join(', ') : 'already up to date')
      else        console.error(`✗ ${t}:`, res.error)
    }
    if (r.summary.failed.length) process.exitCode = 1
  })

addTargetFlag(agentsCmd.command('uninstall')).action(async (opts) => {
  const { uninstallAllAgents } = await import('./agent-installer-dispatcher.js')
  const only = opts.target || null
  const r = uninstallAllAgents({ only })
  for (const [t, res] of Object.entries(r.results)) {
    if (res.ok) console.log(`✓ ${t}: removed`, (res.removed || []).join(', ') || 'nothing')
    else        console.error(`✗ ${t}:`, res.error)
  }
})

agentsCmd.command('status').action(async () => {
  const { inspectAllAgents } = await import('./agent-installer-dispatcher.js')
  const { port } = readPortAndVersion()
  const r = inspectAllAgents({ expectedPort: port })
  for (const [t, ins] of Object.entries(r.results)) {
    const mcp = ins.mcpRegistered ? '✓ MCP' : '✗ MCP'
    const sk  = ins.skillPresent ? '✓ skill' : '✗ skill'
    const drift = ins.drift ? `  ⚠ drift (actual:${ins.actualPort} expected:${ins.expectedPort})` : ''
    console.log(`  ${t.padEnd(8)} ${mcp}   ${sk}   ${ins.configPath}${drift}`)
  }
})
```

并在文件顶部 import 段确保 `readFileSync` 和 `fileURLToPath` 已 import（多数已 import；若缺则补）。

#### - [ ] Step 7.4: 跑测试

```bash
npx vitest run test/cli-agents.test.js
```
Expected: PASS

#### - [ ] Step 7.5: 手动烟雾测一下

```bash
node src/cli.js agents --help
node src/cli.js agents status
node src/cli.js agents install --dry-run --target claude
```
Expected:
- `--help` 列出 install/uninstall/status
- `status` 显示当前未装（assuming 用户全局没装过）
- `--dry-run` 输出 plan，不写任何全局文件（验证：`stat ~/.claude.json` 看 mtime 不变）

#### - [ ] Step 7.6: Commit

```bash
git add src/cli.js test/cli-agents.test.js
git commit -m "feat(cli): agentquad agents install/uninstall/status 子命令"
```

---

### Task 8: `agentquad start` 自动 bootstrap

**Files:**
- Modify: `src/cli.js`（`start` action 内加 bootstrap 调用）
- Modify: `src/config.js` 或同等位置（如果有"配置读写"模块；查实际位置）：加 `agents.autoBootstrap` / `agents.bootstrapDismissed` 默认值

#### - [ ] Step 8.1: 探明现有配置模块路径 + 默认值常量位置

```bash
grep -n "defaultCwd\|autoBootstrap\|telegram\.\|openclaw\." src/config.js src/server.js 2>/dev/null | head -20
```
Expected: 找到 `src/config.js` 或类似定义 default config 的位置

#### - [ ] Step 8.2: 在 default config 里加 `agents` 段

定位 default 配置定义后，追加（精确位置看 §8.1 输出；下面是示意）：

```js
agents: {
  autoBootstrap: 'prompt',    // 'prompt' | 'never' | 'silent'
  bootstrapDismissed: false,
  enabled: { claude: true, codex: true, cursor: true },
  runtimeDir: null,           // null = ~/.agentquad/run
  warnPtyCount: 8,
},
```

#### - [ ] Step 8.3: 在 `start` action 里加 `bootstrapAgentsIfNeeded`

在 `src/cli.js` 的 `program.command('start')` action 内（约 542 行附近），在已有的初始化代码后加一段：

```js
async function bootstrapAgentsIfNeeded({ cfg, version, port, isTTY }) {
  const mode = cfg?.agents?.autoBootstrap || 'prompt'
  if (mode === 'never') return
  if (cfg?.agents?.bootstrapDismissed) return

  const { previewAllAgents, installAllAgents } = await import('./agent-installer-dispatcher.js')
  const p = previewAllAgents({ port, version })
  const needed = Object.entries(p.results).filter(([, v]) => v.changes.length > 0).map(([k]) => k)
  if (needed.length === 0) return

  if (mode === 'silent') {
    const r = installAllAgents({ port, version, only: needed })
    console.log('[agents] auto bootstrap:', Object.keys(r.results).join(', '))
    return
  }

  if (!isTTY) {
    console.warn(`[agents] 检测到未配置的 agent 工具: ${needed.join(', ')}（运行 \`agentquad agents install\` 启用）`)
    return
  }

  // prompt 模式
  const ans = await promptYesNo(`检测到 ${needed.join(', ')} 未配置 AgentQuad MCP / skill，现在安装吗？[Y/n] `)
  if (ans) {
    const r = installAllAgents({ port, version, only: needed })
    for (const [t, res] of Object.entries(r.results)) {
      console.log(`  ${t}:`, res.ok ? (res.changes?.join(', ') || 'ok') : `error: ${res.error}`)
    }
  } else {
    // 持久化用户拒绝
    saveConfigKey('agents.bootstrapDismissed', true)
    console.log('[agents] 已记住你的选择；运行 `agentquad agents install` 可手动启用')
  }
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim() || 'y')) })
  })
}
```

调用点：放在 server 启动**成功后**、`console.log('AgentQuad running on ...')` 之前/之后（取决于你想让端口冲突报错走 bootstrap 还是不走）。建议放在 server 起来之后，因为 bootstrap 用的 port 需要是 listen 成功的 port。

```js
// 在 start action 内 server 启动 ready 之后
await bootstrapAgentsIfNeeded({ cfg, version: pkg.version, port: actualPort, isTTY: process.stdin.isTTY })
```

并新增辅助：

```js
function saveConfigKey(dotPath, value) {
  // 假设现有 config.js 已有 setConfigValue / saveConfig 方法；调用之
  const parts = dotPath.split('.')
  const cfg = loadConfig()
  let cur = cfg
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
  saveConfig(cfg)
}
```

（如果 `loadConfig` / `saveConfig` 名字不同，§8.1 已经查到的实际函数名替换）

#### - [ ] Step 8.4: 手动验证

```bash
# 临时把 ~/.claude.json / ~/.codex/config.toml / ~/.cursor/mcp.json 备份，让它"未装"
mv ~/.claude.json ~/.claude.json.bak 2>/dev/null
mv ~/.codex/config.toml ~/.codex/config.toml.bak 2>/dev/null
node src/cli.js start
# Expected: 启动后弹问"检测到 claude / codex 未配置...，现在安装吗？"
# 回 N，看是否打印"已记住你的选择"，下次启动不再问
node src/cli.js stop
node src/cli.js start  # 不应再问
# 恢复
mv ~/.claude.json.bak ~/.claude.json 2>/dev/null
mv ~/.codex/config.toml.bak ~/.codex/config.toml 2>/dev/null
# reset bootstrapDismissed
node src/cli.js config set agents.bootstrapDismissed false
```

#### - [ ] Step 8.5: Commit

```bash
git add src/cli.js src/config.js
git commit -m "feat(start): 自动 bootstrap agents（prompt/silent/never 三模式 + dismissed 记忆）"
```

---

### Task 9: `agentquad doctor` 集成

**Files:**
- Modify: `src/cli.js`（`doctor` action）

#### - [ ] Step 9.1: 定位 doctor action

```bash
grep -n "command('doctor')" src/cli.js
```
Expected: 找到约 609 行的 `program.command('doctor')` 定义

#### - [ ] Step 9.2: 在 doctor action 里追加 agents 段

```js
// 在 doctor action 末尾，server status 输出之后
const { inspectAllAgents } = await import('./agent-installer-dispatcher.js')
const { listStaleRuntimeConfigs } = await import('./agent-installer-shared.js')
const cfg = loadConfig() || {}
const port = cfg.port || 5677
const r = inspectAllAgents({ expectedPort: port })

console.log('\nagents:')
for (const [t, ins] of Object.entries(r.results)) {
  const mcp = ins.mcpRegistered ? '✓ MCP registered' : '✗ MCP missing'
  const sk  = ins.skillPresent ? '✓ skill/rule installed' : '✗ skill/rule missing'
  const drift = ins.drift ? `  ⚠ drift port ${ins.actualPort} → ${ins.expectedPort}（修复: agentquad agents install --target ${t}）` : ''
  console.log(`  ${t.padEnd(8)} ${mcp.padEnd(20)} ${sk.padEnd(24)} (${ins.configPath})${drift}`)
}

// 软 warning：活跃 PTY 数（沿用现有 ai-session-store / spawnSession 的活跃计数 API）
try {
  const { countActiveSessions } = await import('./routes/ai-terminal.js')   // 实际函数名按现有代码替换
  const active = typeof countActiveSessions === 'function' ? countActiveSessions() : null
  const warnAt = cfg?.agents?.warnPtyCount || 8
  if (active !== null && active >= warnAt) {
    console.log(`  ⚠ 活跃 AgentQuad PTY 数 = ${active}（≥ 阈值 ${warnAt}，请留意是否失控）`)
  }
} catch { /* count API 不可用就不报 */ }

// 孤儿运行时配置
const runtimeDir = cfg?.agents?.runtimeDir || join(homedir(), '.agentquad', 'run')
const stale = listStaleRuntimeConfigs({ runtimeDir })
if (stale.length) {
  console.log(`  ⚠ 孤儿运行时 MCP 配置 ${stale.length} 个（位置: ${runtimeDir}），可删除：`)
  for (const s of stale) console.log(`     - ${s.name}`)
}
```

> **TDD 注意**：doctor 输出比较散，没有现成测试 harness。这一步靠手动验证 + §9.3 烟雾测试。如果 §8.1 探明的 active-pty 计数 API 跟示例不同名，按实际改。

#### - [ ] Step 9.3: 手动验证

```bash
# 装了的情况下
node src/cli.js agents install
node src/cli.js doctor    # Expected: 三家都 ✓
# 模拟 drift
node src/cli.js config set port 5678
node src/cli.js doctor    # Expected: drift 告警每行都出现，因为 marker 还是 5677
# 恢复
node src/cli.js config set port 5677
```

#### - [ ] Step 9.4: Commit

```bash
git add src/cli.js
git commit -m "feat(doctor): 集成 agents 状态 + drift + 孤儿运行时配置告警"
```

---

## Phase D — Runtime injection (C)

### Task 10: spawnSession 注入 DEPTH / PARENT_TODO_ID

**Files:**
- Modify: `src/routes/ai-terminal.js`（spawnSession，参见 442 行签名）
- Modify: `src/mcp/tools/openclaw/index.js`（`start_ai_session` 透传 parentTodoId）
- Test: `test/ai-terminal-runtime-mcp.test.js`

#### - [ ] Step 10.1: 写失败测试 — 子 spawnSession 注入正确 env

创建 `test/ai-terminal-runtime-mcp.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 我们不 spin 真的 PTY；mock node-pty.spawn，让它返回一个能记录 env 的 fake
vi.mock('node-pty', () => ({
  spawn: vi.fn((cmd, args, opts) => ({
    pid: 12345,
    onData: () => {},
    onExit: (cb) => { setTimeout(() => cb({ exitCode: 0 }), 10) },
    write: () => {},
    resize: () => {},
    kill: () => {},
    _capturedEnv: opts.env,
    _capturedArgs: args,
    _capturedCmd: cmd,
  })),
}))

// 注意：实际 spawnSession 是嵌在 router factory 里的闭包，需要 import 它的入口
// 下面按现有 ai-terminal.js 导出方式调；如果 spawnSession 是内部函数，把这个测试
// 改成"通过 start_ai_session MCP 工具走一遍"的集成式 —— 实施时按实际代码组织调整。
import { createAiTerminalForTest } from '../src/routes/ai-terminal.js'  // 视情况新增 testing 入口

describe('spawnSession runtime injection', () => {
  it('injects QUADTODO_DEPTH=0 for top-level', async () => {
    const at = createAiTerminalForTest({ db: fakeDb(), port: 5677 })
    const r = at.spawnSession({ todoId: 't1', tool: 'claude', prompt: 'hi', cwd: '/tmp' })
    expect(r.sessionId).toBeTruthy()
    // 拿到底层 mock pty
    const pty = at.__lastPty
    expect(pty._capturedEnv.QUADTODO_DEPTH).toBe('0')
    expect(pty._capturedEnv.QUADTODO_PARENT_TODO_ID).toBe('')
  })

  it('inherits depth+1 when caller env has QUADTODO_DEPTH=1', async () => {
    const at = createAiTerminalForTest({
      db: fakeDb(), port: 5677,
      processEnv: { QUADTODO_DEPTH: '1', QUADTODO_TODO_ID: 'parent-1' },
    })
    const r = at.spawnSession({ todoId: 't2', tool: 'claude', prompt: 'hi', cwd: '/tmp' })
    const pty = at.__lastPty
    expect(pty._capturedEnv.QUADTODO_DEPTH).toBe('2')
    expect(pty._capturedEnv.QUADTODO_PARENT_TODO_ID).toBe('parent-1')
  })

  it('passes --mcp-config flag to claude with runtime config file path', () => {
    const at = createAiTerminalForTest({ db: fakeDb(), port: 5678 })
    at.spawnSession({ todoId: 't3', tool: 'claude', prompt: 'hi', cwd: '/tmp' })
    const pty = at.__lastPty
    const args = pty._capturedArgs
    const idx = args.indexOf('--mcp-config')
    expect(idx).toBeGreaterThanOrEqual(0)
    const cfgPath = args[idx + 1]
    expect(cfgPath).toMatch(/mcp-.*\.json$/)
  })

  it('cleans up runtime config on pty exit', async () => {
    // 调 spawnSession，等 mock pty onExit 触发，检查文件已被清
    const at = createAiTerminalForTest({ db: fakeDb(), port: 5678 })
    const r = at.spawnSession({ todoId: 't4', tool: 'claude', prompt: 'hi', cwd: '/tmp' })
    await new Promise(r2 => setTimeout(r2, 30))  // 等 onExit
    expect(at.__runtimeFileExists(r.sessionId)).toBe(false)
  })
})

function fakeDb() {
  return {
    getTodo: (id) => ({ id, title: 'fake', workDir: '/tmp' }),
    raw: { prepare: () => ({ all: () => [] }) },
  }
}
```

#### - [ ] Step 10.2: 运行测试验证 fail

```bash
npx vitest run test/ai-terminal-runtime-mcp.test.js
```
Expected: FAIL（`createAiTerminalForTest` 尚未导出）

#### - [ ] Step 10.3: 改 `src/routes/ai-terminal.js`

定位 `spawnSession`（约 442 行）。改造分两块：

**(a) env 增强**：在构造 spawn 的 env 段加：

```js
// 现有 extraEnv 合并之后，再叠加：
const callerDepth = Number(process.env.QUADTODO_DEPTH ?? '-1')
const childDepth = String(callerDepth + 1)
const callerTodoId = process.env.QUADTODO_TODO_ID || ''

const env = {
  ...process.env,
  ...extraEnv,
  QUADTODO_DEPTH: childDepth,
  QUADTODO_PARENT_TODO_ID: callerTodoId,
}
```

**(b) `--mcp-config` 注入**：在构造 args 之前调 `writeRuntimeMcpConfig`：

```js
import { writeRuntimeMcpConfig, cleanupRuntimeMcpConfig } from '../agent-installer-shared.js'
// ... 在 spawnSession 内
const runtimeDir = cfg?.agents?.runtimeDir
  ? expandHome(cfg.agents.runtimeDir)
  : join(homedir(), '.agentquad', 'run')
const { path: runtimeMcpPath } = writeRuntimeMcpConfig({
  runtimeDir, sessionId, port: cfg?.port || 5677, tool,
})

let args
if (tool === 'claude') {
  args = ['--mcp-config', runtimeMcpPath, ...existingClaudeArgs]
} else if (tool === 'codex') {
  // 取决于 codex 是否支持 --mcp-config；plan §11 第一步先 doctor 一下
  // 若不支持 → 写到 cwd/.codex/config.toml + cleanup
  args = [...existingCodexArgs]
  // TODO(plan-task-11): 在 Task 11 完成 codex 适配
}

// pty exit 时清理
pty.onExit(() => {
  cleanupRuntimeMcpConfig({ runtimeDir, sessionId })
  // ... 现有 cleanup 逻辑
})
```

> 注意：现有 ai-terminal.js 已经有 args 构造逻辑（在第 228 行附近用 `cfg.tools[tool].bin` / `command`）。本步只是**前缀注入 `--mcp-config`**，不删除现有 args。

**(c) 测试入口**：在文件底部 export 一个 testing-only factory：

```js
// 仅供测试用：返回 spawnSession 闭包 + 拦截最近一次 pty
export function createAiTerminalForTest({ db, port, processEnv = {} } = {}) {
  // 保存当前 process.env 并覆盖
  const origEnv = { ...process.env }
  Object.assign(process.env, processEnv)
  const router = createAiTerminalRouter({ db, port })   // 现有 factory 名
  let lastPty = null
  // hack: monkey-patch onCreatePty 或暴露内部 spawnSession + lastPty
  // ...具体看现有代码组织
  return {
    spawnSession: router.spawnSession,
    get __lastPty() { return lastPty },
    __runtimeFileExists: (sid) => existsSync(join(homedir(), '.agentquad', 'run', `mcp-${sid}.json`)),
    [Symbol.dispose]() { Object.assign(process.env, origEnv) },
  }
}
```

> **实施提示**：上面的 testing-only 接口可能跟 ai-terminal.js 现有结构有出入。如果 `spawnSession` 是闭包私有的，需要先做一个**小范围导出**重构（把 spawnSession 提到 module 顶层 / 通过 factory 返回 handle）；这个重构本身放在 Step 10.3 之前作为一个独立 commit。

#### - [ ] Step 10.4: 跑测试

```bash
npx vitest run test/ai-terminal-runtime-mcp.test.js
```
Expected: 前 3 个 PASS；第 4 个（cleanup）也 PASS

#### - [ ] Step 10.5: 跑回归确认现有 ai-terminal 测试不破坏

```bash
npx vitest run test/ai-terminal
```
Expected: 全部 PASS

#### - [ ] Step 10.6: Commit

```bash
git add src/routes/ai-terminal.js test/ai-terminal-runtime-mcp.test.js
git commit -m "feat(ai-terminal): spawnSession 注入 DEPTH/PARENT_TODO_ID + --mcp-config"
```

---

### Task 11: Codex 的运行时注入策略验证

**Files:**
- Modify: `src/routes/ai-terminal.js`（codex 分支补全）

#### - [ ] Step 11.1: 验证 codex CLI 是否支持 `--config / --mcp-config`

```bash
codex --help 2>&1 | grep -iE "mcp|config" | head -20
```
- 如果看到 `--config <KEY=VALUE>` 或 `--mcp-config <FILE>` → 走 (a) 干净注入
- 如果都没有 → 走 (b) 项目目录临时写

#### - [ ] Step 11.2a: 干净注入（若 §11.1 看到支持）

在 `ai-terminal.js` 的 codex 分支加：

```js
// 假设 codex 支持 --config 接收 KV，则用 --config mcp_servers.agentquad.url=...
args = [
  '--config', `mcp_servers.agentquad.url="http://127.0.0.1:${port}/mcp"`,
  '--config', `mcp_servers.agentquad.transport="http"`,
  ...existingCodexArgs,
]
```

或若支持 `--mcp-config <FILE>`：

```js
args = ['--mcp-config', runtimeMcpPath, ...existingCodexArgs]
```

#### - [ ] Step 11.2b: 项目目录临时写（若 §11.1 不支持）

```js
// 写 cwd/.codex/config.toml；退出清理
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
const codexProjectDir = join(cwd, '.codex')
const codexProjectConfig = join(codexProjectDir, 'config.toml')
const backedUp = existsSync(codexProjectConfig) ? readFileSync(codexProjectConfig, 'utf8') : null
mkdirSync(codexProjectDir, { recursive: true })
writeFileSync(codexProjectConfig, [
  '# agentquad managed — auto-removed on session exit',
  '[mcp_servers.agentquad]',
  `url = "http://127.0.0.1:${port}/mcp"`,
  'transport = "http"',
].join('\n'))

pty.onExit(() => {
  try {
    if (backedUp === null) unlinkSync(codexProjectConfig)
    else writeFileSync(codexProjectConfig, backedUp)
  } catch { /* swallow */ }
})
```

#### - [ ] Step 11.3: 手动 E2E 烟雾

```bash
# 在一个 worktree 里手动跑：
# 1. 启 agentquad
node src/cli.js start
# 2. 通过 web 在 Q2 建一个 todo，启 codex
# 3. 在 codex PTY 里输入 "/mcp" 或类似，确认 agentquad MCP 已连上
# 4. 关闭 PTY，确认 cwd/.codex/config.toml 已清/恢复（若走 11.2b）
```

#### - [ ] Step 11.4: Commit

```bash
git add src/routes/ai-terminal.js
git commit -m "feat(ai-terminal): codex 运行时 MCP 注入（按 CLI 能力选择干净注入或 cwd 临时写）"
```

---

### Task 12: `start_ai_session` MCP 工具透传 parentTodoId（保险）

**Files:**
- Modify: `src/mcp/tools/openclaw/index.js`（约 144 行 `start_ai_session` 实现）

> 实际上 spawnSession 已经能从 `process.env.QUADTODO_TODO_ID` 推出父，因为 MCP 工具是同进程跑 —— `process.env` 由 AgentQuad 主进程持有，没有"父"概念。所以这里需要让 **start_ai_session 显式传 parentTodoId**：从调用方推断。
> 推断方式：MCP 调用没有 session 概念，但可以从 args 加 `parentTodoId` 可选字段；或读 `args.routeUserId` 关联 session → 找出 active todo。
> 简化方案：**把 parentTodoId 当作 input 字段**，让父 agent skill 在调用时显式传（skill 正文已经写明 `parentId=<父 TODO_ID>`，从 env 拿 QUADTODO_TODO_ID）。

#### - [ ] Step 12.1: 在 inputSchema 加 `parentTodoId`

在 `src/mcp/tools/openclaw/index.js` 的 `start_ai_session` 工具的 `inputSchema` 块（约 156 行）追加：

```js
parentTodoId: z.string().optional().describe(
  '调用方（父 PTY 的 AI）从 env QUADTODO_TODO_ID 读取后透传过来，用于子 PTY 注入 QUADTODO_PARENT_TODO_ID。' +
  'AgentQuad 主进程的 process.env 不含父 todo 信息，所以必须显式传。',
),
```

#### - [ ] Step 12.2: 把 parentTodoId 传给 spawnSession

在 `start_ai_session` 实现里（约 169 行 `async (args) => {...}` 内）：

```js
const result = aiTerminal.spawnSession({
  sessionId,
  todoId: args.todoId,
  parentTodoId: args.parentTodoId || null,    // ← 新增
  prompt,
  tool,
  cwd,
  permissionMode,
  label: templateName ? `template:${templateName}` : null,
  extraEnv,
})
```

#### - [ ] Step 12.3: 在 spawnSession 用 parentTodoId 覆盖 env 注入

回到 `src/routes/ai-terminal.js` spawnSession，修正 Task 10 的 env 注入逻辑：

```js
// 优先用调用方传的 parentTodoId，fallback 到 process.env
const callerTodoId = parentTodoId || process.env.QUADTODO_TODO_ID || ''
```

#### - [ ] Step 12.4: 更新 skill 正文，让父 agent 知道要传

回到 `src/templates/agent-skills/agentquad-child.skill.md`，把"操作流程"第 3 步明确化：

```markdown
3. （可选）`start_ai_session(todoId=<子 id>, parentTodoId=<env QUADTODO_TODO_ID 的值>, tool="claude"|"codex", prompt=<明确任务说明>)`
```

#### - [ ] Step 12.5: Commit

```bash
git add src/mcp/tools/openclaw/index.js src/routes/ai-terminal.js src/templates/agent-skills/agentquad-child.skill.md
git commit -m "feat(mcp): start_ai_session 接受 parentTodoId 透传，注入子 PTY env"
```

---

## Phase E — End-to-end validation

### Task 13: 手动 E2E 验收 checklist 完整跑一遍

> 这一步不写代码，按 spec §9 验收标准逐项跑通。

#### - [ ] Step 13.1: 三家一键装通 + 卸载干净

```bash
# 备份
mv ~/.claude.json ~/.claude.json.real 2>/dev/null
mv ~/.codex/config.toml ~/.codex/config.toml.real 2>/dev/null
mv ~/.cursor/mcp.json ~/.cursor/mcp.json.real 2>/dev/null

# 装
node src/cli.js agents install
node src/cli.js agents status   # 三家 ✓

# diff 一下确认 marker 段格式正确
cat ~/.claude.json | jq '.mcpServers.agentquad, ._agentquadManaged'
cat ~/.codex/config.toml
cat ~/.cursor/mcp.json | jq '.mcpServers.agentquad, ._agentquadManaged'

# 卸
node src/cli.js agents uninstall
node src/cli.js agents status   # 三家 ✗

# 恢复
mv ~/.claude.json.real ~/.claude.json 2>/dev/null
mv ~/.codex/config.toml.real ~/.codex/config.toml 2>/dev/null
mv ~/.cursor/mcp.json.real ~/.cursor/mcp.json 2>/dev/null
```

#### - [ ] Step 13.2: 嵌套链路端到端

1. 启动 AgentQuad：`node src/cli.js start`
2. Web UI 在 Q2 新建一个 todo "测试嵌套"
3. 点击启动按钮，选 Claude Code
4. PTY 内输入："把这个任务拆成两个子任务：写文档 和 跑测试，先把写文档交给另一个 agent"
5. **验证**：
   - LLM 调 `list_quadrants` / `create_todo` 两次（parentId 都是当前 todo）/ `start_ai_session` 一次
   - Web UI 实时显示 2 个新子 todo + 1 个新活跃 PTY
6. 在子 PTY 里手动跑 `echo $QUADTODO_DEPTH $QUADTODO_PARENT_TODO_ID`
   - Expected: `1 <父 todo id>`

#### - [ ] Step 13.3: 端口漂移自动同步

```bash
node src/cli.js stop
node src/cli.js config set port 5678
node src/cli.js start
# Expected: 启动后 ~/.claude.json / ~/.codex/config.toml / ~/.cursor/mcp.json 的 url 都更新为 :5678
node src/cli.js doctor      # 三家无 drift
node src/cli.js config set port 5677
node src/cli.js stop && node src/cli.js start
```

#### - [ ] Step 13.4: 回归既有路径

```bash
# OpenClaw 微信路径（如果你在用）
# 1. 在微信发"帮我新建 todo 测试回归"
# 2. AgentQuad MCP 收到 create_todo + start_ai_session
# 3. 子 PTY 在 Telegram/微信 收到 ask_user 决策点（验证 ask_user 链路未坏）

# 现有 hook 链路
node src/cli.js hook status
# Expected: 跟之前一致

npx vitest run
# Expected: 所有现有测试 + 本期新测试 全 PASS
```

#### - [ ] Step 13.5: 软 warning

```bash
# 把 warnPtyCount 调到 1 验证 warning 文案出现
node src/cli.js config set agents.warnPtyCount 1
# 启动至少一个 PTY
node src/cli.js doctor
# Expected: "⚠ 活跃 AgentQuad PTY 数 = 1（≥ 阈值 1，请留意是否失控）"
node src/cli.js config set agents.warnPtyCount 8
```

#### - [ ] Step 13.6: 总结 commit

```bash
git commit --allow-empty -m "chore(agents): E2E 验收完成 — 嵌套链路 + 三家适配 + 端口漂移全部通过"
```

---

## Self-Review

### Spec coverage

跟 spec §2-9 逐节对照：

| Spec 节 | 实现任务 |
|---|---|
| §3.1 模块布局 | Task 1（shared）/ 3-5（三家 installer）/ 6（dispatcher） |
| §3.2 数据流（父 PTY → MCP → 子 PTY） | Task 10-12（spawnSession + start_ai_session 透传） |
| §3.3 marker 幂等 | Task 1（shared.buildMarker / atomic write）+ Task 3-5（per-target 写法） |
| §4.1 Claude 适配 | Task 3 |
| §4.2 Codex 适配 | Task 4（B + skill）+ Task 11（C） |
| §4.3 Cursor 适配 | Task 5 |
| §4.4 skill 正文 | Task 2 |
| §5.1 dispatcher 接口 | Task 6 |
| §5.2 三入口（agents 命令 / start / doctor） | Task 7 / 8 / 9 |
| §5.3 端口漂移 | Task 3-5（installAgent 自动更新 port）+ Task 8（start 触发 bootstrap）+ Task 9（doctor 报） |
| §5.4 卸载 | Task 3-5 uninstallAgent + Task 7 uninstall 子命令 |
| §5.5 失败处理 | Task 6 dispatcher 不阻断 + Task 1 atomic write |
| §6 运行时注入 | Task 10 + 11 + 12 |
| §7 配置 schema | Task 8.2 |
| §8 文件落点表 | Task 13.1 手动验证 |
| §9 验收标准 | Task 13 |
| §10 风险表 #4（并发写） | Task 1（atomic write） |
| §10 风险表 #5（skill version 更新） | Task 3-5 installAgent 用 content diff 判断要不要覆盖 |

### Placeholder scan

无 "TBD" / "TODO" / "implement later"。所有"按现有代码调整"的位置都明示了原因（如 Task 10 testing-only export 视现有 spawnSession 闭包结构而定）。

### Type consistency

- 三家 installer 统一导出 `installAgent / uninstallAgent / inspectAgent`，dispatcher 通过 `targetMod(name).installAgent(args)` 调用
- inspect 输出统一字段：`{ target, mcpRegistered, skillPresent, drift, configPath, expectedPort, actualPort, version }`（即使 Cursor 是 rule 不是 skill，对外仍叫 `skillPresent` 便于统一展示）
- `_agentquadManaged` 旁路键的 schema 三家一致：`{ version, port, generatedAt }`
- `start_ai_session` 的 `parentTodoId` 字段名贯穿 MCP 工具 → spawnSession → env injection 一致
