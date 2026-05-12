// web/src/AiTerminalMini.scrollSnap.ts
//
// 纯函数：根据 xterm buffer 的 baseY / viewportY 和当前 followTail，
// 决定要不要程序化吸附到底部、是否更新 followTail。
//
// 拆出来单独成文件的原因：让 vitest 不必 import 整个挂着 xterm/React 的
// AiTerminalMini.tsx，测试可以保持轻量。

/**
 * 「距离绝对底部 ≤ N 行就被吸附」中的 N。
 * xterm 在绝对底部时 viewportY === baseY；向上每滚 1 行 viewportY 减 1。
 */
export const NEAR_BOTTOM_LINES = 4

export interface NearBottomAction {
  /** 调用方应执行 `term.scrollToBottom()`。 */
  snap: boolean
  /**
   * `null` = 不变；`true`/`false` = 需要 setState 到该值（并写 localStorage）。
   */
  nextFollowTail: boolean | null
}

/**
 * @param baseY  xterm `buffer.active.baseY`，活动屏第一行在整个 buffer 中的索引。
 * @param dispY  xterm `buffer.active.viewportY`，视口最上一行在整个 buffer 中的索引。
 * @param followTail 当前 followTail 状态。
 * @param nearBottomLines 吸附阈值（行），等于 `NEAR_BOTTOM_LINES`。注入便于单测。
 */
export function decideNearBottomAction(
  baseY: number,
  dispY: number,
  followTail: boolean,
  nearBottomLines: number,
): NearBottomAction {
  const delta = Math.max(0, baseY - dispY)

  if (delta === 0) {
    return { snap: false, nextFollowTail: followTail ? null : true }
  }

  if (delta <= nearBottomLines) {
    return { snap: true, nextFollowTail: followTail ? null : true }
  }

  return { snap: false, nextFollowTail: followTail ? false : null }
}
