import { describe, it, expect, vi } from 'vitest'
import { createLoadingTracker } from '../src/telegram-loading-status.js'

function makeHarness({ route = null, mockTime = null } = {}) {
  const editedTopics = []
  const telegramBot = {
    editForumTopic: vi.fn(async (args) => {
      editedTopics.push(args)
      return { ok: true }
    }),
  }
  const defaultRoute = {
    targetUserId: '-1001234',
    threadId: 42,
    topicName: '#t42 修复 login bug',
  }
  const resolvedRoute = route === null ? defaultRoute : route
  const openclaw = {
    resolveRoute: vi.fn((sid) => sid === 'sess-x' ? resolvedRoute : null),
  }
  let _now = Date.now()
  const tracker = createLoadingTracker({
    telegramBot, openclaw,
    logger: { info() {}, warn() {} },
    now: mockTime ? () => _now : undefined,
  })
  return {
    tracker, editedTopics, telegramBot, openclaw,
    advanceTime: (ms) => { _now += ms },
  }
}

describe('createLoadingTracker — terminal-only title rename', () => {
  it('start does NOT rename topic to "🔄 <name>" anymore (reaction-tracker handles running)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)
    expect(h.tracker.has('sess-x')).toBe(true)
  })

  it('renames topic to "✅ <name>" on done', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(1)
    expect(h.editedTopics[0].name).toBe('✅ #t42 修复 login bug')
    expect(h.tracker.has('sess-x')).toBe(false)
  })

  it('renames to "❌ <name>" on failed', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'failed' })
    expect(h.editedTopics[0].name).toBe('❌ #t42 修复 login bug')
  })

  it('renames to "⏹ <name>" on stopped', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.stop({ sessionId: 'sess-x', finalStatus: 'stopped' })
    expect(h.editedTopics[0].name).toBe('⏹ #t42 修复 login bug')
  })

  it('skips when no telegram route', async () => {
    const h = makeHarness({ route: null })
    await h.tracker.start({ sessionId: 'no-route' })
    expect(h.editedTopics).toHaveLength(0)
    expect(h.tracker.size()).toBe(0)
  })

  it('skips when route has no topicName', async () => {
    const h = makeHarness({ route: { targetUserId: '-1', threadId: 1, topicName: null } })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('does not throw when telegramBot lacks editForumTopic', async () => {
    const tracker = createLoadingTracker({
      telegramBot: {},
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: { info() {}, warn() {} },
    })
    await expect(tracker.start({ sessionId: 'sess-x' })).resolves.not.toThrow()
    await expect(tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })).resolves.not.toThrow()
  })

  it('idempotent: starting same sessionId twice is no-op (no rename now)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.start({ sessionId: 'sess-x' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('stop on unknown sessionId is no-op', async () => {
    const h = makeHarness()
    await h.tracker.stop({ sessionId: 'unknown', finalStatus: 'done' })
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markIdle is a no-op (reaction-tracker handles idle)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.markIdle('sess-x')
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markRunning is a no-op (reaction-tracker handles running)', async () => {
    const h = makeHarness()
    await h.tracker.start({ sessionId: 'sess-x' })
    await h.tracker.markRunning('sess-x')
    expect(h.editedTopics).toHaveLength(0)
  })

  it('markIdle / markRunning on unknown sessionId is also no-op', async () => {
    const h = makeHarness()
    await h.tracker.markIdle('unknown')
    await h.tracker.markRunning('unknown')
    expect(h.editedTopics).toHaveLength(0)
  })
})

describe('createLoadingTracker — terminal rename rate limit', () => {
  it('terminal rename ignores backoff state from earlier 429 (✅/❌/⏹ must show)', async () => {
    let callCount = 0
    const editsAfterBackoff = []
    const telegramBot = {
      editForumTopic: vi.fn(async (args) => {
        callCount++
        if (callCount === 1) {
          const err = new Error('429')
          err.description = 'Too Many Requests: retry after 30'
          throw err
        }
        editsAfterBackoff.push(args)
        return { ok: true }
      }),
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: {
        resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 'mytopic' }),
      },
      logger: { info() {}, warn() {} },
    })
    await tracker.start({ sessionId: 'sess-x' })
    await tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })
    expect(callCount).toBe(1)
    await tracker.start({ sessionId: 'sess-y' })
    await tracker.stop({ sessionId: 'sess-y', finalStatus: 'done' })
    expect(callCount).toBe(2)
    expect(editsAfterBackoff[0].name).toBe('✅ mytopic')
  })

  it('treats "TOPIC_NOT_MODIFIED" as success (no warn)', async () => {
    let warned = false
    const telegramBot = {
      editForumTopic: async () => {
        const err = new Error('400')
        err.description = 'Bad Request: TOPIC_NOT_MODIFIED'
        throw err
      },
    }
    const tracker = createLoadingTracker({
      telegramBot,
      openclaw: { resolveRoute: () => ({ targetUserId: '-1', threadId: 1, topicName: 't' }) },
      logger: { info() {}, warn() { warned = true } },
    })
    await tracker.start({ sessionId: 'sess-x' })
    await expect(tracker.stop({ sessionId: 'sess-x', finalStatus: 'done' })).resolves.not.toThrow()
    expect(warned).toBe(false)
  })
})
