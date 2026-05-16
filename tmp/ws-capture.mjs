import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const SID = process.argv[2] || 'ai-1778911364043-eud3'
const ws = new WebSocket(`ws://127.0.0.1:5677/ws/terminal/${SID}`)

let captured = []
let replayChunks = null

ws.on('open', () => {
  console.error('connected, sending init')
  ws.send(JSON.stringify({ type: 'init', cols: 200, rows: 50, role: 'secondary' }))
})

ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw.toString())
    if (msg.type === 'replay') {
      replayChunks = msg.chunks
      console.error('got replay:', msg.chunks?.length, 'chunks')
    } else if (msg.type === 'output') {
      captured.push(msg.data)
    }
  } catch {}
})

setTimeout(() => {
  const tailRaw = (replayChunks || []).join('').slice(-8000) + captured.join('')
  writeFileSync('/tmp/pty-tail.txt', tailRaw, 'utf8')
  writeFileSync('/tmp/pty-tail-escaped.txt', JSON.stringify(tailRaw), 'utf8')
  console.error('wrote', tailRaw.length, 'bytes')
  ws.close()
  process.exit(0)
}, 3000)
