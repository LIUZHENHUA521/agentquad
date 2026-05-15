/**
 * 失败重试编排：按 backoffMs 数组依次等待→调用 recover()。
 * 任意一次返回 true 即视为恢复成功；isCancelled 在每次 sleep 前后都检查一次，
 * 用于组件 unmount / 用户主动关闭终端时立刻退出循环。
 *
 * 注入式 sleep 让单测可以零等待跑完三次循环。
 */

export type RecoveryOutcome = 'recovered' | 'cancelled' | 'exhausted'

export interface RunWithBackoffOpts {
  backoffMs: number[]
  recover: (attempt: number) => Promise<boolean>
  isCancelled?: () => boolean
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function runWithBackoff(opts: RunWithBackoffOpts): Promise<RecoveryOutcome> {
  const sleep = opts.sleep ?? defaultSleep
  const isCancelled = opts.isCancelled ?? (() => false)

  for (let i = 0; i < opts.backoffMs.length; i++) {
    if (isCancelled()) return 'cancelled'
    await sleep(opts.backoffMs[i])
    if (isCancelled()) return 'cancelled'

    const ok = await opts.recover(i + 1)
    if (ok) return 'recovered'
  }
  return 'exhausted'
}
