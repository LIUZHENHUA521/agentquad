import WebSocket from 'ws'
import { writeFileSync, existsSync, statSync } from 'node:fs'

const SID = process.argv[2] || 'ai-1778911364043-eud3'
const OUT = process.argv[3] || '/tmp/pty-poll.txt'
const ws = new WebSocket(`ws://127.0.0.1:5677/ws/terminal/${SID}`)

let buf = ''

ws.on('open', () => {
  console.error('[capture] connected')
  ws.send(JSON.stringify({ type: 'init', cols: 240, rows: 50, role: 'secondary' }))
})

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'replay') {
      // skip replay - we want only new
    } else if (msg.type === 'output') {
      buf += msg.data
      writeFileSync(OUT, buf, 'utf8')
    }
  } catch {}
})

setInterval(() => {
  writeFileSync(OUT, buf, 'utf8')
}, 1000).unref?.()

// Stop after 90s
setTimeout(() => { ws.close(); process.exit(0) }, 90_000).unref?.()

// Keep alive
setInterval(() => {}, 60_000)
