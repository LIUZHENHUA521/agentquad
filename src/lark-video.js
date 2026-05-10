/**
 * 飞书视频入站：跟 lark-image 类似，但用 getMessageResource(type:'file')。
 *
 * 飞书的视频消息 msg_type === 'media'，content 形如：
 *   { file_key: 'media_v3_xxx', image_key: 'img_v2_xxx'(封面，可选), file_name: 'a.mp4', duration: 12345 }
 *
 * extractVideoFileKey 只处理 msg_type === 'media' 的消息，避免误吃 image 消息封面。
 * 当前只支持单视频（飞书一次发一条），返回 null 或 { fileKey, fileName, duration }。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_DIR = join(homedir(), '.quadtodo', 'lark-uploads')

const CONTENT_TYPE_TO_EXT = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'video/mpeg': 'mpeg',
}

export function videoExtFromContentType(headers) {
  const ct = String(
    headers?.['content-type']
    || headers?.['Content-Type']
    || ''
  ).toLowerCase()
  for (const [type, ext] of Object.entries(CONTENT_TYPE_TO_EXT)) {
    if (ct.includes(type)) return ext
  }
  return 'mp4'  // 飞书视频默认 mp4，未知 mime 兜底成 mp4 比 bin 更安全
}

// 视频类的 msg_type 枚举：飞书国际版 / 国内版 / 不同事件版本可能用不同枚举名，
// 这里把已知的全列上，宽松识别。'file' 在 file_name 看起来是视频时也认。
const VIDEO_MSG_TYPES = new Set(['media', 'video'])

const VIDEO_FILE_NAME_RE = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mpeg|mpg|wmv|flv)$/i

/**
 * 从飞书 message 提取视频 file_key。
 * 容忍多种 shape：
 *   - msg_type/message_type ∈ {media, video} → content.file_key 直接拿
 *   - msg_type === 'file' 且 file_name 后缀是视频格式 → 也认
 *   - content.file_key 不在顶层时，尝试 content.video.file_key / content.media.file_key
 *
 * @returns {{ fileKey: string, fileName: string|null, duration: number|null, msgType: string|null } | null}
 */
export function extractVideoFileKey(message = {}) {
  if (!message || typeof message !== 'object') return null
  const msgType = message.msg_type || message.message_type || null

  let content = message.content
  if (typeof content === 'string') {
    try { content = JSON.parse(content) } catch { content = null }
  }
  if (!content || typeof content !== 'object') return null

  // 多路径找 file_key
  const fileKey = pickFirstString([
    content.file_key,
    content.video?.file_key,
    content.media?.file_key,
  ])
  if (!fileKey) return null

  const fileName = pickFirstString([
    content.file_name,
    content.video?.file_name,
    content.media?.file_name,
  ]) || null

  // 决定要不要认领这条消息：
  //   - 已知视频类 msg_type → 直接认
  //   - 'file' 类型 + 视频后缀 → 认
  //   - msg_type 为空/未知，但 content 里有 file_key + 视频后缀 → 也认（兜底）
  let claim = false
  if (msgType && VIDEO_MSG_TYPES.has(String(msgType).toLowerCase())) {
    claim = true
  } else if (fileName && VIDEO_FILE_NAME_RE.test(fileName)) {
    claim = true
  }
  if (!claim) return null

  const duration = typeof content.duration === 'number' ? content.duration : null

  return { fileKey, fileName, duration, msgType }
}

function pickFirstString(candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
  }
  return null
}

/**
 * @param opts.apiClient lark-api-client 实例（必须有 getMessageResource）
 * @param opts.messageId 飞书 message_id
 * @param opts.fileKey content.file_key
 * @param opts.fileName 用于推扩展名（可选；优先级低于 content-type）
 * @param opts.destDir 目标目录
 * @returns {Promise<{ ok: true, localPath } | { ok: false, reason, detail? }>}
 */
export async function downloadLarkVideo({
  apiClient,
  messageId,
  fileKey,
  fileName = null,
  destDir = DEFAULT_DIR,
} = {}) {
  if (!apiClient?.getMessageResource) return { ok: false, reason: 'apiClient_required' }
  if (!messageId) return { ok: false, reason: 'messageId_required' }
  if (!fileKey) return { ok: false, reason: 'fileKey_required' }

  const r = await apiClient.getMessageResource({ messageId, fileKey, type: 'file' })
  if (!r?.ok) return { ok: false, reason: r?.reason || 'lark_resource_failed', detail: r?.detail }
  if (typeof r.writeFile !== 'function') return { ok: false, reason: 'no_writefile' }

  try {
    mkdirSync(destDir, { recursive: true })
  } catch (e) {
    return { ok: false, reason: 'mkdir_failed', detail: e.message }
  }

  // 优先：content-type → mime → ext；fallback：file_name 后缀
  let ext = videoExtFromContentType(r.headers || {})
  if (ext === 'mp4' && fileName) {
    const dot = fileName.lastIndexOf('.')
    if (dot > 0 && dot < fileName.length - 1) {
      const guess = fileName.slice(dot + 1).toLowerCase()
      if (/^[a-z0-9]{2,5}$/.test(guess)) ext = guess
    }
  }
  const localName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const localPath = join(destDir, localName)
  try {
    await r.writeFile(localPath)
  } catch (e) {
    return { ok: false, reason: 'write_failed', detail: e.message }
  }
  return { ok: true, localPath }
}
