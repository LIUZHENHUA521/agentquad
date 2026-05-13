/**
 * 同步对账按钮：覆盖 telegram + lark 两条 channel。
 * 先 dry-run 预览要做的动作，让用户确认后再真做。
 *   - open_topic / open_thread: PTY 活但没绑 topic/thread → 建
 *   - close_topic / close_thread: PTY 死但还绑着 → 关 + mark done
 *   - clear_route: 孤儿路由 → 清
 */
import { useEffect, useState } from 'react'
import { Button, Modal, Tag, Tooltip } from 'antd'
import { SyncOutlined } from '@ant-design/icons'
import { useTranslation } from 'react-i18next'
import { syncChannels, SyncResponse, SyncActionType } from './api'
import { useAppMessages } from './design/useAppMessages'
import { useDispatchStore } from './store/dispatchStore'

const TYPE_COLOR: Record<SyncActionType, string> = {
  open_topic: 'green',
  close_topic: 'red',
  open_thread: 'cyan',
  close_thread: 'magenta',
  clear_route: 'orange',
}

export default function TelegramSyncButton() {
  const { t } = useTranslation(['settings', 'common'])
  const { message } = useAppMessages()
  const TYPE_LABEL: Record<SyncActionType, string> = {
    open_topic: t('settings:sync.action.openTopic'),
    close_topic: t('settings:sync.action.closeTopic'),
    open_thread: t('settings:sync.action.openThread'),
    close_thread: t('settings:sync.action.closeThread'),
    clear_route: t('settings:sync.action.clearRoute'),
  }
  const [loading, setLoading] = useState(false)
  const [plan, setPlan] = useState<SyncResponse | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [executing, setExecuting] = useState(false)

  // M4-T4: react to CommandPalette "Telegram sync" command via dispatchStore signal.
  const telegramSyncSignal = useDispatchStore((s) => s.signals.telegramSync === true)
  const consumeSignal = useDispatchStore((s) => s.consumeSignal)
  useEffect(() => {
    if (!telegramSyncSignal) return
    void preview()
    consumeSignal('telegramSync')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [telegramSyncSignal, consumeSignal])

  async function preview() {
    setLoading(true)
    try {
      const res = await syncChannels(true)
      setPlan(res)
      if (res.summary.total === 0) {
        message.success(t('settings:sync.allSynced'))
      } else {
        setConfirmOpen(true)
      }
    } catch (e) {
      message.error(t('settings:sync.previewFailed', { msg: (e as Error).message }))
    } finally {
      setLoading(false)
    }
  }

  async function execute() {
    setExecuting(true)
    try {
      const res = await syncChannels(false)
      const ok = res.summary.succeeded || 0
      const fail = res.summary.failed || 0
      if (fail > 0) {
        message.warning(t('settings:sync.execMixed', { ok, fail }))
      } else {
        message.success(t('settings:sync.execAllOk', { ok }))
      }
      setPlan(res)
      setConfirmOpen(false)
    } catch (e) {
      message.error(t('settings:sync.execFailed', { msg: (e as Error).message }))
    } finally {
      setExecuting(false)
    }
  }

  return (
    <>
      <Tooltip title={t('settings:sync.buttonTooltip')}>
        <Button
          icon={<SyncOutlined spin={loading} />}
          size="small"
          loading={loading}
          onClick={preview}
        >
          {t('settings:sync.button')}
        </Button>
      </Tooltip>
      <Modal
        title={t('settings:sync.previewTitle')}
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={execute}
        okText={t('settings:sync.executeOk', { count: plan?.summary.total ?? 0 })}
        cancelText={t('settings:sync.cancel')}
        confirmLoading={executing}
        width={680}
      >
        {plan && (
          <>
            <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('settings:sync.summary.tg')} <b>{plan.summary.open_topic}</b> · {t('settings:sync.summary.close')} <b>{plan.summary.close_topic}</b>
              {' ｜ '}
              {t('settings:sync.summary.lark')} <b>{plan.summary.open_thread}</b> · {t('settings:sync.summary.close')} <b>{plan.summary.close_thread}</b>
              {' ｜ '}
              {t('settings:sync.summary.clear')} <b>{plan.summary.clear_route}</b>
            </div>
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
              {plan.actions.map((a, i) => (
                <div
                  key={i}
                  style={{
                    padding: '6px 8px',
                    borderBottom: '1px solid #f0f0f0',
                    fontSize: 13,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <Tag color={TYPE_COLOR[a.type]}>{TYPE_LABEL[a.type]}</Tag>
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.todoTitle || a.sessionId || a.rootMessageId || `thread ${a.threadId}`}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{a.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>
    </>
  )
}
