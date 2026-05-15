import { describe, it, expect, vi } from 'vitest'
import { runWithBackoff } from '../web/src/aiTerminalRecovery.ts'

describe('runWithBackoff', () => {
  it('returns "recovered" when recover succeeds on first attempt', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValueOnce(true)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      sleep,
    })

    expect(outcome).toBe('recovered')
    expect(recover).toHaveBeenCalledTimes(1)
    expect(recover).toHaveBeenCalledWith(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it('keeps retrying with each backoff and reports attempt index', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      sleep,
    })

    expect(outcome).toBe('recovered')
    expect(recover.mock.calls.map(c => c[0])).toEqual([1, 2, 3])
    expect(sleep.mock.calls.map(c => c[0])).toEqual([10, 20, 30])
  })

  it('returns "exhausted" after all attempts fail', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValue(false)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      sleep,
    })

    expect(outcome).toBe('exhausted')
    expect(recover).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('returns "cancelled" before any attempt when isCancelled is true upfront', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValue(true)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      isCancelled: () => true,
      sleep,
    })

    expect(outcome).toBe('cancelled')
    expect(recover).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('returns "cancelled" mid-loop and skips remaining attempts', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn().mockResolvedValue(false)
    let cancelAfter = 1
    const isCancelled = vi.fn(() => recover.mock.calls.length >= cancelAfter)

    const outcome = await runWithBackoff({
      backoffMs: [10, 20, 30],
      recover,
      isCancelled,
      sleep,
    })

    expect(outcome).toBe('cancelled')
    expect(recover).toHaveBeenCalledTimes(1)
  })
})
