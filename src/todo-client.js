/**
 * 轻量 HTTP 客户端：让 CLI（`agentquad todo …`）和脚本直接驱动正在运行的
 * AgentQuad server 的 /api/todos。
 *
 * 设计原则：
 *   - 走 HTTP 而不是直连 SQLite —— 复用 server 端全部校验 + 副作用（标记 done 时
 *     自动关 PTY、board SSE 通知前端刷新），保证 CLI 写入和 Web UI 行为完全一致。
 *   - 因此前提是 server 在跑；没跑就抛 server_not_running，由调用方给出友好提示。
 *   - fetch 可注入（fetchImpl），方便测试不起真服务。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ROOT_DIR } from './config.js'

/**
 * 读取 ~/.agentquad/agentquad.pid，确认进程活着，拼出 base URL。
 * 与 cli.js 的 readPidFile 同源逻辑（容忍 legacy 纯数字格式），这里独立实现以避免
 * cli.js ↔ todo-client.js 循环依赖。
 *
 * @returns {string} 形如 http://127.0.0.1:5677
 * @throws {Error} code='server_not_running'：没有 pid 文件 / 进程已死 / 缺端口
 */
export function resolveServerUrl({ rootDir = DEFAULT_ROOT_DIR, configPort } = {}) {
  const pf = join(rootDir, 'agentquad.pid')
  const fail = (msg) => {
    const e = new Error(msg)
    e.code = 'server_not_running'
    return e
  }
  if (!existsSync(pf)) throw fail('server_not_running')

  let info = null
  let raw = ''
  try { raw = readFileSync(pf, 'utf8').trim() } catch { throw fail('server_not_running') }
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj.pid === 'number' && obj.pid > 0) info = obj
  } catch { /* legacy plain-number pid file */ }
  if (!info) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) info = { pid: n }
  }
  if (!info?.pid) throw fail('server_not_running')

  try { process.kill(info.pid, 0) } catch { throw fail('server_not_running') }

  const port = info.port ?? configPort
  if (!port) throw fail('server_not_running')
  // pid 文件里的 host 可能是 0.0.0.0（绑全网卡）——CLI 永远走回环访问本机
  return `http://127.0.0.1:${port}`
}

/**
 * 发一个请求并解析 JSON。失败（网络错 / 非 2xx / body.ok===false）抛 Error，
 * Error.status / Error.apiError 携带服务端细节。
 */
export async function request({ baseUrl, method = 'GET', path, body, fetchImpl = fetch } = {}) {
  if (!baseUrl) throw new Error('baseUrl_required')
  const url = `${baseUrl}${path}`
  let res
  try {
    res = await fetchImpl(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    const err = new Error(`request_failed: ${e.message}`)
    err.code = 'request_failed'
    throw err
  }
  let data = {}
  try { data = await res.json() } catch { /* 非 JSON / 空 body */ }
  if (!res.ok || data?.ok === false) {
    const err = new Error(data?.error || `http_${res.status}`)
    err.status = res.status
    err.apiError = data?.error || null
    throw err
  }
  return data
}

// ─── 高阶封装：每个对应一个 /api/todos 端点 ──────────────────────────────

export async function apiCreateTodo(ctx, { title, description, dueDate, workDir, brainstorm, parentId } = {}) {
  const body = { title }
  if (description !== undefined) body.description = description
  if (dueDate !== undefined && dueDate !== null) body.dueDate = dueDate
  if (workDir !== undefined) body.workDir = workDir
  if (brainstorm !== undefined) body.brainstorm = brainstorm
  if (parentId !== undefined) body.parentId = parentId
  const data = await request({ ...ctx, method: 'POST', path: '/api/todos', body })
  return data.todo
}

export async function apiListTodos(ctx, { status, keyword } = {}) {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (keyword) qs.set('keyword', keyword)
  const suffix = qs.toString() ? `?${qs}` : ''
  const data = await request({ ...ctx, method: 'GET', path: `/api/todos${suffix}` })
  return data.list || []
}

export async function apiGetTodo(ctx, id) {
  const data = await request({ ...ctx, method: 'GET', path: `/api/todos/${encodeURIComponent(id)}` })
  return { todo: data.todo, comments: data.comments || [], children: data.children || [] }
}

export async function apiUpdateTodo(ctx, id, patch = {}) {
  const data = await request({ ...ctx, method: 'PUT', path: `/api/todos/${encodeURIComponent(id)}`, body: patch })
  return data.todo
}

export async function apiCompleteTodo(ctx, id) {
  return apiUpdateTodo(ctx, id, { status: 'done' })
}

export async function apiAddComment(ctx, id, content) {
  const data = await request({ ...ctx, method: 'POST', path: `/api/todos/${encodeURIComponent(id)}/comments`, body: { content } })
  return data.comment
}

export async function apiDeleteTodo(ctx, id) {
  await request({ ...ctx, method: 'DELETE', path: `/api/todos/${encodeURIComponent(id)}` })
  return true
}

/**
 * 把 --due 入参解析成毫秒 epoch。
 * 接受：纯数字（当 ms epoch）、ISO 日期串、`YYYY-MM-DD`。无法解析返回 null。
 */
export function parseDueDate(input) {
  if (input === undefined || input === null || input === '') return null
  if (typeof input === 'number') return input
  const s = String(input).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}
