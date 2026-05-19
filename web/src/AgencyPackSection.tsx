import { useEffect, useState, useCallback } from 'react'
import { Card, Button, Tag, Space, Typography, message } from 'antd'
import { useTranslation } from 'react-i18next'
import {
  listTemplatePacks,
  installTemplatePack,
  uninstallTemplatePack,
  type TemplatePack,
} from './api'

const { Text, Paragraph } = Typography

interface Props {
  onChanged?: () => void
}

export default function AgencyPackSection({ onChanged }: Props) {
  const { t } = useTranslation(['settings'])
  const [packs, setPacks] = useState<TemplatePack[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPacks(await listTemplatePacks())
    } catch (e: any) {
      message.error(e?.message || 'failed to load packs')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const onInstall = async (id: string) => {
    setBusy(id)
    try {
      const { installed } = await installTemplatePack(id)
      message.success(t('settings:templatePacks.installedOk', { n: installed }))
      await refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || 'install failed')
    } finally { setBusy(null) }
  }

  const onUninstall = async (id: string) => {
    setBusy(id)
    try {
      await uninstallTemplatePack(id)
      message.success(t('settings:templatePacks.uninstalledOk'))
      await refresh()
      onChanged?.()
    } catch (e: any) {
      message.error(e?.message || 'uninstall failed')
    } finally { setBusy(null) }
  }

  if (packs.length === 0) return null

  return (
    <div style={{ marginTop: 24 }}>
      <Typography.Title level={5} style={{ marginBottom: 4 }}>
        {t('settings:templatePacks.sectionTitle')}
      </Typography.Title>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        {t('settings:templatePacks.sectionDesc')}
      </Paragraph>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {packs.map(p => {
          const key = `settings:templatePacks.packs.${p.id}` as const
          return (
            <Card key={p.id} size="small">
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space>
                  <Text strong>{t(`${key}.name` as any, p.id)}</Text>
                  {p.installed
                    ? <Tag color="green">{t('settings:templatePacks.installedCount', { n: p.entryCount })}</Tag>
                    : <Tag>{t('settings:templatePacks.availableCount', { n: p.entryCount })}</Tag>
                  }
                </Space>
                <Text type="secondary">{t(`${key}.desc` as any, '')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('settings:templatePacks.attribution', { src: p.attribution, license: p.license })}
                </Text>
                <div>
                  {p.installed ? (
                    <Button
                      danger
                      size="small"
                      loading={busy === p.id}
                      onClick={() => onUninstall(p.id)}
                    >{t('settings:templatePacks.uninstall')}</Button>
                  ) : (
                    <Button
                      type="primary"
                      size="small"
                      loading={busy === p.id}
                      onClick={() => onInstall(p.id)}
                    >{t('settings:templatePacks.install')}</Button>
                  )}
                </div>
              </Space>
            </Card>
          )
        })}
      </Space>
    </div>
  )
}
