import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveServerUrl,
  parseDueDate,
  apiCreateTodo,
  apiListTodos,
  apiGetTodo,
  apiUpdateTodo,
  apiCompleteTodo,
  apiAddComment,
  apiDeleteTodo,
  apiSpawnSession,
} from '../src/todo-client.js'

describe('todo-client resolveServerUrl', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aq-todocli-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('throws server_not_running when no pid file', () => {
    expect(() => resolveServerUrl({ rootDir: dir })).toThrowError(/server_not_running/)
  })

  it('returns loopback url from a live JSON pid file', () => {
    writeFileSync(join(dir, 'agentquad.pid'), JSON.stringify({ pid: process.pid, port: 7788, host: '0.0.0.0' }))
    expect(resolveServerUrl({ rootDir: dir })).toBe('http://127.0.0.1:7788')
  })

  it('falls back to configPort for legacy plain-number pid file', () => {
    writeFileSync(join(dir, 'agentquad.pid'), String(process.pid))
    expect(resolveServerUrl({ rootDir: dir, configPort: 5677 })).toBe('http://127.0.0.1:5677')
  })

  it('throws when the recorded pid is not alive', () => {
    // 一个几乎不可能存在的 pid
    writeFileSync(join(dir, 'agentquad.pid'), JSON.stringify({ pid: 2147483640, port: 7788 }))
    expect(() => resolveServerUrl({ rootDir: dir })).toThrowError(/server_not_running/)
  })

  it('throws when alive but no port resolvable', () => {
    writeFileSync(join(dir, 'agentquad.pid'), JSON.stringify({ pid: process.pid }))
    expect(() => resolveServerUrl({ rootDir: dir })).toThrowError(/server_not_running/)
  })
})

describe('todo-client parseDueDate', () => {
  it('passes through numbers and numeric strings as ms epoch', () => {
    expect(parseDueDate(1700000000000)).toBe(1700000000000)
    expect(parseDueDate('1700000000000')).toBe(1700000000000)
  })
  it('parses ISO / YYYY-MM-DD', () => {
    expect(parseDueDate('2026-06-01')).toBe(Date.parse('2026-06-01'))
  })
  it('returns null for empty / unparseable', () => {
    expect(parseDueDate('')).toBeNull()
    expect(parseDueDate(null)).toBeNull()
    expect(parseDueDate('not-a-date')).toBeNull()
  })
})

// fetch 桩：记录每次调用，返回预设响应
function makeFetchStub(responses) {
  const calls = []
  let i = 0
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.json ?? { ok: true },
    }
  }
  return { fetchImpl, calls }
}

describe('todo-client api helpers', () => {
  const baseUrl = 'http://127.0.0.1:5677'

  it('apiCreateTodo POSTs only the provided fields', async () => {
    const { fetchImpl, calls } = makeFetchStub([{ json: { ok: true, todo: { id: 't1', title: 'Hi' } } }])
    const todo = await apiCreateTodo({ baseUrl, fetchImpl }, { title: 'Hi', dueDate: 123, brainstorm: true })
    expect(todo).toEqual({ id: 't1', title: 'Hi' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://127.0.0.1:5677/api/todos')
    expect(calls[0].body).toEqual({ title: 'Hi', dueDate: 123, brainstorm: true })
  })

  it('apiListTodos builds query string', async () => {
    const { fetchImpl, calls } = makeFetchStub([{ json: { ok: true, list: [{ id: 'a' }] } }])
    const list = await apiListTodos({ baseUrl, fetchImpl }, { status: 'done', keyword: 'login' })
    expect(list).toEqual([{ id: 'a' }])
    expect(calls[0].url).toBe('http://127.0.0.1:5677/api/todos?status=done&keyword=login')
  })

  it('apiGetTodo returns todo + comments + children', async () => {
    const { fetchImpl } = makeFetchStub([{ json: { ok: true, todo: { id: 'x' }, comments: [{ content: 'c' }], children: [] } }])
    const out = await apiGetTodo({ baseUrl, fetchImpl }, 'x')
    expect(out.todo.id).toBe('x')
    expect(out.comments).toHaveLength(1)
    expect(out.children).toEqual([])
  })

  it('apiCompleteTodo PUTs status done', async () => {
    const { fetchImpl, calls } = makeFetchStub([{ json: { ok: true, todo: { id: 'x', status: 'done' } } }])
    await apiCompleteTodo({ baseUrl, fetchImpl }, 'x')
    expect(calls[0].method).toBe('PUT')
    expect(calls[0].url).toBe('http://127.0.0.1:5677/api/todos/x')
    expect(calls[0].body).toEqual({ status: 'done' })
  })

  it('apiUpdateTodo / apiAddComment / apiDeleteTodo hit the right endpoints', async () => {
    const upd = makeFetchStub([{ json: { ok: true, todo: { id: 'x' } } }])
    await apiUpdateTodo({ baseUrl, fetchImpl: upd.fetchImpl }, 'x', { title: 'N' })
    expect(upd.calls[0].method).toBe('PUT')
    expect(upd.calls[0].body).toEqual({ title: 'N' })

    const com = makeFetchStub([{ json: { ok: true, comment: { id: 'c1' } } }])
    await apiAddComment({ baseUrl, fetchImpl: com.fetchImpl }, 'x', 'hello')
    expect(com.calls[0].url).toBe('http://127.0.0.1:5677/api/todos/x/comments')
    expect(com.calls[0].body).toEqual({ content: 'hello' })

    const del = makeFetchStub([{ json: { ok: true } }])
    const ok = await apiDeleteTodo({ baseUrl, fetchImpl: del.fetchImpl }, 'x')
    expect(del.calls[0].method).toBe('DELETE')
    expect(ok).toBe(true)
  })

  it('apiSpawnSession POSTs to /api/ai-terminal/exec and returns sessionId', async () => {
    const { fetchImpl, calls } = makeFetchStub([{ json: { ok: true, sessionId: 'ai-1', reused: false } }])
    const r = await apiSpawnSession({ baseUrl, fetchImpl }, { todoId: 't1', prompt: 'do it', tool: 'claude', cwd: '/tmp', permissionMode: 'bypass' })
    expect(r).toEqual({ sessionId: 'ai-1', reused: false })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://127.0.0.1:5677/api/ai-terminal/exec')
    expect(calls[0].body).toEqual({ todoId: 't1', prompt: 'do it', tool: 'claude', cwd: '/tmp', permissionMode: 'bypass' })
  })

  it('apiSpawnSession omits cwd/permissionMode when not provided', async () => {
    const { fetchImpl, calls } = makeFetchStub([{ json: { ok: true, sessionId: 'ai-2' } }])
    await apiSpawnSession({ baseUrl, fetchImpl }, { todoId: 't1', prompt: 'p', tool: 'codex' })
    expect(calls[0].body).toEqual({ todoId: 't1', prompt: 'p', tool: 'codex' })
  })

  it('throws an Error carrying status + apiError on a non-ok response', async () => {
    const { fetchImpl } = makeFetchStub([{ ok: false, status: 404, json: { ok: false, error: 'not_found' } }])
    await expect(apiGetTodo({ baseUrl, fetchImpl }, 'nope')).rejects.toMatchObject({ status: 404, message: 'not_found' })
  })

  it('surfaces apiCode + apiFix from a tool_missing (424) response', async () => {
    const { fetchImpl } = makeFetchStub([{ ok: false, status: 424, json: { ok: false, code: 'tool_missing', error: 'tool_missing: cursor', fix: 'agentquad install-tools --cursor' } }])
    await expect(apiSpawnSession({ baseUrl, fetchImpl }, { todoId: 't', prompt: 'p', tool: 'cursor' }))
      .rejects.toMatchObject({ status: 424, apiCode: 'tool_missing', apiFix: 'agentquad install-tools --cursor' })
  })
})
