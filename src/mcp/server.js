import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { registerReadTools } from './tools/read/index.js'
import { registerWriteTools } from './tools/write/index.js'
import { registerDestructiveTools } from './tools/destructive/index.js'
import { registerOpenClawTools } from './tools/openclaw/index.js'
import { createAuditLog } from './audit.js'
import { createTranscriptScanner } from '../search/transcripts.js'

const SERVER_NAME = 'agentquad'

/**
 * 创建一个挂在 Express 下的 MCP Streamable HTTP 路由。
 *
 * 关键：MCP SDK 的 stateless 模式（sessionIdGenerator: undefined）规定每个 HTTP 请求
 * 必须用新的 transport —— 共享会抛 "Stateless transport cannot be reused"。所以我们
 * 在每次请求时新建 transport + server + tool 注册，audit / scanner 这种重对象在 router
 * 工厂里建一次就够，复用给每个 per-request server。
 *
 * 依赖：
 *   - db：openDb(...) 返回的句柄
 *   - searchService：createSearchService 返回
 *   - wikiDir：wiki .md 文件所在目录（用于 read_wiki）
 *   - getVersion()：可选，注入当前 AgentQuad 版本
 *   - aiTerminal：可选，{ spawnSession }，用于 start_ai_session
 *   - openclaw：可选，OpenClaw bridge 句柄
 *   - pending：可选，pending-question coordinator 句柄
 *   - getConfig：可选，() => 当前配置快照
 */
export function createMcpRouter({
  db, searchService, wikiDir, rootDir, logDir, getVersion,
  aiTerminal = null, openclaw = null, pending = null, getConfig = null,
} = {}) {
  if (!db) throw new Error('db_required')
  if (!searchService) throw new Error('searchService_required')

  // 重对象只建一次，复用给 per-request server
  const audit = rootDir ? createAuditLog({ rootDir }) : null
  const transcriptScanner = logDir ? createTranscriptScanner({ db, logDir }) : null
  const serverVersion = (typeof getVersion === 'function' && getVersion()) || '0.1.0'

  function buildServer() {
    const server = new McpServer({ name: SERVER_NAME, version: serverVersion })
    registerReadTools(server, { db, searchService, wikiDir, transcriptScanner })
    registerWriteTools(server, { db })
    registerDestructiveTools(server, { db, audit })
    if (pending) {
      registerOpenClawTools(server, { db, aiTerminal, openclaw, pending, getConfig })
    }
    return server
  }

  const router = express.Router()
  // MCP Streamable HTTP 约定：客户端用 POST /mcp 下发 JSON-RPC；
  // SSE 重连或 server-sent 流走 GET。stateless 模式下两种方法都走同一段：
  // 每请求一个全新 transport + server。
  const handle = async (req, res) => {
    let transport
    let server
    try {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      server = buildServer()
      await server.connect(transport)

      // 请求结束/客户端断开时清理；防止泄漏
      res.on('close', () => {
        try { transport.close?.() } catch { /* ignore */ }
        try { server.close?.() } catch { /* ignore */ }
      })

      await transport.handleRequest(req, res, req.body)
    } catch (e) {
      console.error('[mcp] handleRequest threw:', e?.stack || e?.message || e)
      try { transport?.close?.() } catch { /* ignore */ }
      try { server?.close?.() } catch { /* ignore */ }
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: e?.message || 'internal_error' },
          id: null,
        })
      }
    }
  }
  router.post('/', handle)
  router.get('/', handle)
  router.delete('/', handle)

  // 健康检查（MCP 客户端一般不走这个，但方便 `agentquad mcp status` 和运维）
  router.get('/health', (_req, res) => {
    res.json({ ok: true, server: SERVER_NAME, version: serverVersion })
  })

  return { router }
}
