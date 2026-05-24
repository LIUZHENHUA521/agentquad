// 极薄的 in-process 事件总线，专给 board-level 通知用：
// "server 端独立改了 todos / aiSessions，前端该 refetch 列表了"。
//
// 设计选择：单实例 EventEmitter，跨 server.js / openclaw-hook.js / wizard 共享。
// 不持久化、不重放——SSE 订阅前的 emit 直接丢弃；客户端断线重连后自然走下一次 emit。
// emit 频率天然受限（hook 触发节奏），不做 debounce 也不会刷爆。

import { EventEmitter } from 'node:events'

class BoardEventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(64)  // 一个 server 最多 64 个并发浏览器 tab，应足够
  }

  /** 通知"看板上的 todos / aiSessions 有变化，前端可以 refetch 了"。
   *  detail 是可选元信息（来源、todoId 等），方便前端做更精细的 invalidate；
   *  当前消费方只用了"任意 change → 整刷"的粗粒度策略。 */
  notifyTodosChanged(detail = {}) {
    this.emit('changed', { type: 'todos', at: Date.now(), ...detail })
  }
}

export const boardEventBus = new BoardEventBus()
