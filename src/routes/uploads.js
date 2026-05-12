/**
 * Web 端粘贴/拖拽图片上传：
 *   POST /api/uploads/image
 *     body: { filename: 'paste.png', mime: 'image/png', dataBase64: '...' }
 *     返回：{ ok: true, path: '/Users/.../...png', fileSize: number }
 *
 * 用 base64 JSON 而不是 multipart：
 *   - 不引新依赖（multer / busboy）
 *   - 粘贴图通常 <2MB，base64 33% 开销可忍
 *   - 大文件 / 多文件场景以后真有需求再换 multipart
 *
 * 文件落到 ~/.agentquad/web-uploads/<ts>-<rand>.<ext>，跟 telegram tg-uploads 同模式。
 */
import { Router } from 'express'
import { mkdirSync, writeFileSync, statSync, realpathSync } from 'node:fs'
import { join, resolve as resolvePath, sep } from 'node:path'
import { Buffer } from 'node:buffer'
import { DEFAULT_ROOT_DIR } from '../config.js'

const DEFAULT_UPLOAD_DIR = join(DEFAULT_ROOT_DIR, 'web-uploads')
const MAX_BYTES = 20 * 1024 * 1024  // 20MB，跟 telegram 一致

const SAFE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif',
  'pdf', 'txt', 'md', 'json', 'log', 'csv',
])

function sanitizeExt(filename, mime) {
  // 优先 filename 后缀；缺失或不安全 → 退到 mime 推断
  const m = String(filename || '').match(/\.([a-zA-Z0-9]{1,8})$/)
  let ext = m ? m[1].toLowerCase() : null
  if (!ext || !SAFE_EXTS.has(ext)) {
    if (/^image\/(png|jpeg|jpg|gif|webp|bmp|svg)/.test(mime || '')) {
      ext = mime.split('/')[1].replace('+xml', '').toLowerCase()
    } else if (/^application\/pdf/.test(mime || '')) {
      ext = 'pdf'
    } else {
      ext = 'bin'
    }
  }
  return ext
}

export function createUploadsRouter({ uploadDir = DEFAULT_UPLOAD_DIR, logger = console } = {}) {
  const router = Router()

  router.post('/image', (req, res) => {
    try {
      const { filename, mime, dataBase64 } = req.body || {}
      if (!dataBase64 || typeof dataBase64 !== 'string') {
        return res.status(400).json({ ok: false, error: 'dataBase64_required' })
      }
      // 大致预估 base64 解码后大小：bytes ≈ b64len * 3/4
      if (dataBase64.length * 3 / 4 > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: 'file_too_large', limitMB: 20 })
      }
      const buf = Buffer.from(dataBase64, 'base64')
      if (buf.length > MAX_BYTES) {
        return res.status(413).json({ ok: false, error: 'file_too_large', limitMB: 20 })
      }
      mkdirSync(uploadDir, { recursive: true })
      const ext = sanitizeExt(filename, mime)
      const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const localPath = join(uploadDir, localName)
      writeFileSync(localPath, buf)
      logger.info?.(`[uploads] saved ${(buf.length / 1024).toFixed(1)}kB → ${localPath}`)
      res.json({ ok: true, path: localPath, fileSize: buf.length, ext })
    } catch (e) {
      logger.warn?.(`[uploads] save failed: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message || 'upload_failed' })
    }
  })

  router.get('/file', (req, res) => {
    try {
      const raw = String(req.query.path || '')
      if (!raw) return res.status(400).json({ ok: false, error: 'path_required' })
      // Resolve symlinks for both root and file so a symlink inside the upload
      // dir can't escape the sandbox.
      let rootAbs
      try { rootAbs = realpathSync(resolvePath(uploadDir)) + sep } catch {
        // upload dir doesn't exist yet → nothing inside it can possibly be served
        return res.status(404).json({ ok: false, error: 'not_found' })
      }
      let fileAbs
      try { fileAbs = realpathSync(resolvePath(raw)) } catch {
        return res.status(404).json({ ok: false, error: 'not_found' })
      }
      if (!(fileAbs + sep).startsWith(rootAbs)) {
        return res.status(403).json({ ok: false, error: 'forbidden_path' })
      }
      const st = statSync(fileAbs)
      if (!st.isFile()) return res.status(404).json({ ok: false, error: 'not_a_file' })
      // Defensive headers: prevent SVG/HTML uploads from executing scripts when
      // served back. Content-Type is still inferred by sendFile from extension.
      res.set('Content-Disposition', 'inline')
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      res.set('X-Content-Type-Options', 'nosniff')
      return res.sendFile(fileAbs)
    } catch (e) {
      logger.warn?.(`[uploads] serve failed: ${e.message}`)
      res.status(500).json({ ok: false, error: e.message || 'serve_failed' })
    }
  })

  return router
}
