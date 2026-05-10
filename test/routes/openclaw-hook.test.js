import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createOpenClawHookRouter } from '../../src/routes/openclaw-hook.js'

function makeApp(handler) {
  const app = express()
  app.use(express.json())
  app.use('/api/openclaw/hook', createOpenClawHookRouter({ hookHandler: handler }))
  return app
}

describe('openclaw-hook router', () => {
  it('forwards source=claude (default) to handler', async () => {
    const handle = vi.fn(async () => ({ ok: true }))
    const res = await request(makeApp({ handle })).post('/api/openclaw/hook').send({ event: 'Stop' })
    expect(res.status).toBe(200)
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ source: 'claude' }))
  })

  it('forwards source=codex,path=jsonl', async () => {
    const handle = vi.fn(async () => ({ ok: true }))
    await request(makeApp({ handle })).post('/api/openclaw/hook').send({ source: 'codex', path: 'jsonl', event: 'Stop', nativeId: 'n1' })
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ source: 'codex', path: 'jsonl', nativeId: 'n1' }))
  })

  it('forwards source=codex,path=detector', async () => {
    const handle = vi.fn(async () => ({ ok: true }))
    await request(makeApp({ handle })).post('/api/openclaw/hook').send({ source: 'codex', path: 'detector', event: 'Notification', sessionId: 'qs1', promptText: 'Approve?' })
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ path: 'detector', sessionId: 'qs1' }))
  })

  it('rejects unsupported body shape', async () => {
    const handle = vi.fn()
    const res = await request(makeApp({ handle })).post('/api/openclaw/hook').send({ source: 'codex', path: 'unknown' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unsupported_body_shape')
    expect(handle).not.toHaveBeenCalled()
  })
})
