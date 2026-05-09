import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadLarkImage, extractImageKeys, extFromContentType } from '../src/lark-image.js'

describe('extractImageKeys', () => {
  it('returns content.image_key for plain image messages', () => {
    expect(extractImageKeys({ content: '{"image_key":"img_abc"}' })).toEqual(['img_abc'])
    expect(extractImageKeys({ content: { image_key: 'img_def' } })).toEqual(['img_def'])
  })

  it('returns image_keys from img tags inside post messages', () => {
    const post = {
      content: JSON.stringify({
        content: [
          [{ tag: 'text', text: '看' }, { tag: 'img', image_key: 'img_in_post_1' }],
          [{ tag: 'img', image_key: 'img_in_post_2' }],
        ],
      }),
    }
    expect(extractImageKeys(post)).toEqual(['img_in_post_1', 'img_in_post_2'])
  })

  it('returns empty array when message has no image content', () => {
    expect(extractImageKeys({ content: '{"text":"hello"}' })).toEqual([])
    expect(extractImageKeys({})).toEqual([])
    expect(extractImageKeys({ content: null })).toEqual([])
  })
})

describe('extFromContentType', () => {
  it('maps common image content-types to file extensions', () => {
    expect(extFromContentType({ 'content-type': 'image/png' })).toBe('png')
    expect(extFromContentType({ 'Content-Type': 'image/jpeg; charset=binary' })).toBe('jpg')
    expect(extFromContentType({ 'content-type': 'image/gif' })).toBe('gif')
    expect(extFromContentType({ 'content-type': 'image/webp' })).toBe('webp')
  })

  it('falls back to bin for unknown content types', () => {
    expect(extFromContentType({ 'content-type': 'application/octet-stream' })).toBe('bin')
    expect(extFromContentType({})).toBe('bin')
    expect(extFromContentType(null)).toBe('bin')
  })
})

describe('downloadLarkImage', () => {
  it('downloads an image to disk via apiClient.getMessageResource + writeFile', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lark-img-'))
    try {
      let writtenPath = null
      const apiClient = {
        getMessageResource: vi.fn().mockResolvedValue({
          ok: true,
          headers: { 'content-type': 'image/png' },
          writeFile: async (p) => { writtenPath = p; return p },
        }),
      }
      const r = await downloadLarkImage({ apiClient, messageId: 'om_x', imageKey: 'img_y', destDir: tmp })

      expect(r.ok).toBe(true)
      expect(r.localPath).toMatch(/\.png$/)
      expect(r.localPath.startsWith(tmp)).toBe(true)
      expect(writtenPath).toBe(r.localPath)
      expect(apiClient.getMessageResource).toHaveBeenCalledWith({
        messageId: 'om_x',
        fileKey: 'img_y',
        type: 'image',
      })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns structured error when getMessageResource fails', async () => {
    const apiClient = {
      getMessageResource: vi.fn().mockResolvedValue({ ok: false, reason: 'lark_resource_failed', detail: 'forbidden' }),
    }
    const r = await downloadLarkImage({ apiClient, messageId: 'om_x', imageKey: 'img_y' })
    expect(r).toEqual({ ok: false, reason: 'lark_resource_failed', detail: 'forbidden' })
  })

  it('validates required inputs', async () => {
    await expect(downloadLarkImage({})).resolves.toEqual({ ok: false, reason: 'apiClient_required' })
    await expect(downloadLarkImage({ apiClient: { getMessageResource: () => {} } })).resolves.toEqual({ ok: false, reason: 'messageId_required' })
    await expect(downloadLarkImage({ apiClient: { getMessageResource: () => {} }, messageId: 'om_x' })).resolves.toEqual({ ok: false, reason: 'imageKey_required' })
  })

  it('reports write_failed when writeFile throws', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lark-img-fail-'))
    try {
      const apiClient = {
        getMessageResource: vi.fn().mockResolvedValue({
          ok: true,
          headers: { 'content-type': 'image/png' },
          writeFile: async () => { throw new Error('disk full') },
        }),
      }
      const r = await downloadLarkImage({ apiClient, messageId: 'om_x', imageKey: 'img_y', destDir: tmp })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('write_failed')
      expect(r.detail).toBe('disk full')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
