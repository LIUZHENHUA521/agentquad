/**
 * 把飞书入站图片下载到本地，让 PTY stdin 写 `@<path>` 喂给 Claude Code attach。
 *
 * 流程：
 *   1) lark-api-client.getMessageResource({messageId, fileKey, type:'image'}) → SDK
 *      返回 { writeFile, getReadableStream, headers }
 *   2) 根据 headers['content-type'] 推扩展名（image/png → png, image/jpeg → jpg, ...）
 *   3) writeFile 落到 ~/.agentquad/lark-uploads/<ts>-<rand>.<ext>
 *   4) 返回本地绝对路径
 *
 * 不主动清理：磁盘占用可忽略（图片量级一般几百 KB）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ROOT_DIR } from './config.js'

const DEFAULT_DIR = join(DEFAULT_ROOT_DIR, 'lark-uploads')

const CONTENT_TYPE_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
}

export function extFromContentType(headers) {
  const ct = String(
    headers?.['content-type']
    || headers?.['Content-Type']
    || ''
  ).toLowerCase()
  for (const [type, ext] of Object.entries(CONTENT_TYPE_TO_EXT)) {
    if (ct.includes(type)) return ext
  }
  return 'bin'
}

/**
 * @param opts.apiClient lark-api-client 实例（或类似 shape：必须有 getMessageResource）
 * @param opts.messageId 飞书 message_id（图片所在的消息）
 * @param opts.imageKey content.image_key（普通 image 消息）或 post 里 img 节点的 image_key
 * @param opts.destDir 目标目录（默认 ~/.agentquad/lark-uploads）
 * @returns {Promise<{ ok: true, localPath } | { ok: false, reason, detail? }>}
 */
export async function downloadLarkImage({ apiClient, messageId, imageKey, destDir = DEFAULT_DIR } = {}) {
  if (!apiClient?.getMessageResource) return { ok: false, reason: 'apiClient_required' }
  if (!messageId) return { ok: false, reason: 'messageId_required' }
  if (!imageKey) return { ok: false, reason: 'imageKey_required' }

  const r = await apiClient.getMessageResource({ messageId, fileKey: imageKey, type: 'image' })
  if (!r?.ok) return { ok: false, reason: r?.reason || 'lark_resource_failed', detail: r?.detail }
  if (typeof r.writeFile !== 'function') return { ok: false, reason: 'no_writefile' }

  try {
    mkdirSync(destDir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: 'mkdir_failed', detail: e.message }
  }
  const ext = extFromContentType(r.headers || {})
  const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const localPath = join(destDir, localName)
  try {
    await r.writeFile(localPath)
  } catch (e) {
    return { ok: false, reason: 'write_failed', detail: e.message }
  }
  return { ok: true, localPath }
}

/**
 * 从飞书 message 提取所有 image_key。
 * 普通 image 消息：content.image_key。
 * post 富文本：content.content[][].tag === 'img' 节点的 image_key。
 */
export function extractImageKeys(message = {}) {
  const keys = []
  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = null }
  }
  if (!content || typeof content !== 'object') return keys
  if (typeof content.image_key === 'string' && content.image_key) {
    keys.push(content.image_key)
  }
  if (Array.isArray(content.content)) {
    for (const line of content.content) {
      if (!Array.isArray(line)) continue
      for (const node of line) {
        if (node?.tag === 'img' && typeof node.image_key === 'string' && node.image_key) {
          keys.push(node.image_key)
        }
      }
    }
  }
  return keys
}
