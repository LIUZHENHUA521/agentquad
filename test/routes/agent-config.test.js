import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentConfigRouter, buildToolFiles } from '../../src/routes/agent-config.js'

function silentLogger() { return { info() {}, warn() {} } }

function makeApp({ home } = {}) {
  const app = express()
  app.use(express.json())
  app.use(
    '/api/agent-config',
    createAgentConfigRouter({
      logger: silentLogger(),
      ...(home ? { getHome: () => home } : {}),
    }),
  )
  return app
}

describe('agent-config router', () => {
  it('GET /unknownTool 返回 404', async () => {
    const res = await request(makeApp()).get('/api/agent-config/xxx')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('unknown_tool')
  })

  it('GET /claude 返回 settings + mcp 的 meta', async () => {
    const res = await request(makeApp()).get('/api/agent-config/claude')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const ids = res.body.files.map((f) => f.id).sort()
    expect(ids).toEqual(['mcp', 'settings'])
    for (const f of res.body.files) {
      expect(typeof f.path).toBe('string')
      expect(typeof f.exists).toBe('boolean')
      expect(typeof f.size).toBe('number')
      expect(['json', 'toml']).toContain(f.format)
    }
  })

  it('GET /codex 包含 config.toml', async () => {
    const res = await request(makeApp()).get('/api/agent-config/codex')
    expect(res.status).toBe(200)
    const ids = res.body.files.map((f) => f.id)
    expect(ids).toContain('config')
    const tomlFile = res.body.files.find((f) => f.id === 'config')
    expect(tomlFile.format).toBe('toml')
  })

  it('GET /:tool/file?id=bogus 返回 unknown_file', async () => {
    const res = await request(makeApp()).get('/api/agent-config/claude/file?id=evil')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('unknown_file')
  })

  it('白名单不会暴露 ~/.ssh 之类的任意文件', () => {
    const files = buildToolFiles('/Users/anyone')
    for (const tool of Object.keys(files)) {
      for (const f of files[tool]) {
        // 路径必须落在 ~/.{tool} 或 ~/.claude.json 这种已知点，不允许是 .ssh / .aws / .bashrc
        expect(f.path).toMatch(/\/\.(claude|codex|cursor)[./]/)
      }
    }
  })

  it('PUT 校验 JSON 语法，非法 JSON 返回 400', async () => {
    const res = await request(makeApp())
      .put('/api/agent-config/cursor/file')
      .send({ id: 'cli', content: '{bad json' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_json')
  })

  it('PUT 拒绝 content 缺失', async () => {
    const res = await request(makeApp())
      .put('/api/agent-config/cursor/file')
      .send({ id: 'cli' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('content_required')
  })

  describe('真实读写（隔离到 tmp HOME）', () => {
    let tmpHome

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'agentquad-config-test-'))
    })

    afterEach(() => {
      try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
    })

    it('GET file 在文件不存在时返回 content=""', async () => {
      const res = await request(makeApp({ home: tmpHome })).get('/api/agent-config/claude/file?id=settings')
      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.exists).toBe(false)
      expect(res.body.content).toBe('')
    })

    it('PUT 写入文件 + 备份', async () => {
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      mkdirSync(join(tmpHome, '.claude'), { recursive: true })
      writeFileSync(settingsPath, '{"old":true}')

      const res = await request(makeApp({ home: tmpHome }))
        .put('/api/agent-config/claude/file')
        .send({ id: 'settings', content: '{"new":1}' })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(readFileSync(settingsPath, 'utf8')).toBe('{"new":1}')

      // 备份文件应存在
      expect(res.body.backup).toBeTruthy()
      expect(existsSync(res.body.backup)).toBe(true)
      expect(readFileSync(res.body.backup, 'utf8')).toBe('{"old":true}')
    })

    it('PUT 在文件不存在时创建（无备份）', async () => {
      const res = await request(makeApp({ home: tmpHome }))
        .put('/api/agent-config/cursor/file')
        .send({ id: 'cli', content: '{"hello":1}' })

      expect(res.status).toBe(200)
      expect(res.body.ok).toBe(true)
      expect(res.body.backup).toBeNull()
      const cliPath = join(tmpHome, '.cursor', 'cli-config.json')
      expect(readFileSync(cliPath, 'utf8')).toBe('{"hello":1}')
    })

    it('PUT 允许空 content（清空文件）', async () => {
      const res = await request(makeApp({ home: tmpHome }))
        .put('/api/agent-config/codex/file')
        .send({ id: 'config', content: '' })
      expect(res.status).toBe(200)
      const p = join(tmpHome, '.codex', 'config.toml')
      expect(readFileSync(p, 'utf8')).toBe('')
    })
  })
})
