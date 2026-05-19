import { useEffect, useState, useCallback, useMemo } from 'react'
import { Card, Button, Tag, Space, Typography, message, Modal, Tree, Input, Empty } from 'antd'
import type { DataNode } from 'antd/es/tree'
import { useTranslation } from 'react-i18next'
import {
  listTemplatePacks,
  installTemplatePack,
  uninstallTemplatePack,
  type TemplatePack,
  type TemplatePackEntry,
} from './api'

const { Text, Paragraph } = Typography

interface Props {
  onChanged?: () => void
}

// Prefix scheme keeps category and agent keys in disjoint namespaces inside the Tree.
const catKey = (slug: string) => `cat:${slug}`
const agentKey = (name: string) => `agent:${name}`

export default function AgencyPackSection({ onChanged }: Props) {
  const { t } = useTranslation(['settings'])
  const [packs, setPacks] = useState<TemplatePack[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [pickerFor, setPickerFor] = useState<TemplatePack | null>(null)
  const [pickedNames, setPickedNames] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    try { setPacks(await listTemplatePacks()) } catch (e: any) {
      message.error(e?.message || 'failed to load packs')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const openPicker = (p: TemplatePack) => {
    // Server-running-old-code guard: previous picker required `categories`;
    // the tree picker also needs the per-entry `entries` list.
    if (!Array.isArray(p.categories) || !Array.isArray(p.entries)) {
      message.error(t('settings:templatePacks.serverStale', {
        defaultValue: 'Server is running old code — restart with `npm run stop && npm start` to use the picker.',
      }))
      return
    }
    setPickerFor(p)
    setPickedNames(new Set(p.installedNames || []))
    setSearch('')
  }
  const closePicker = () => {
    setPickerFor(null)
    setPickedNames(new Set())
    setSearch('')
  }

  // Group entries by category for tree rendering (respect categories order from API).
  const groupedEntries = useMemo(() => {
    if (!pickerFor) return [] as Array<{ slug: string; label: string; count: number; entries: TemplatePackEntry[] }>
    const byCat = new Map<string, TemplatePackEntry[]>()
    for (const e of pickerFor.entries) {
      const arr = byCat.get(e.category) || []
      arr.push(e)
      byCat.set(e.category, arr)
    }
    return pickerFor.categories.map(c => ({
      slug: c.slug,
      label: t(`settings:template.categoryLabels.${c.slug}` as any, c.label || c.slug),
      count: c.count,
      entries: (byCat.get(c.slug) || []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
  }, [pickerFor, t])

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return groupedEntries
    return groupedEntries
      .map(g => {
        const catLabel = g.label.toLowerCase()
        const catMatches = catLabel.includes(q) || g.slug.toLowerCase().includes(q)
        const entries = g.entries.filter(e => {
          if (catMatches) return true
          return (
            e.name.toLowerCase().includes(q) ||
            (e.nameEn || '').toLowerCase().includes(q) ||
            (e.description || '').toLowerCase().includes(q)
          )
        })
        return { ...g, entries }
      })
      .filter(g => g.entries.length > 0)
  }, [groupedEntries, search])

  const treeData: DataNode[] = useMemo(() => {
    return filteredGroups.map(g => {
      const allCheckedInGroup = g.entries.length > 0 && g.entries.every(e => pickedNames.has(e.name))
      const partial = !allCheckedInGroup && g.entries.some(e => pickedNames.has(e.name))
      return {
        key: catKey(g.slug),
        title: (
          <span>
            <Text strong>{g.label}</Text>
            <Text type="secondary" style={{ marginLeft: 6 }}>· {g.entries.length}/{g.count}</Text>
            {partial && (
              <Tag color="blue" style={{ marginLeft: 8 }}>
                {g.entries.filter(e => pickedNames.has(e.name)).length}
              </Tag>
            )}
          </span>
        ),
        children: g.entries.map(e => ({
          key: agentKey(e.name),
          title: (
            <span>
              {e.emoji && <span style={{ marginRight: 4 }}>{e.emoji}</span>}
              <Text>{e.name}</Text>
              {e.nameEn && <Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>· {e.nameEn}</Text>}
            </span>
          ),
        })),
      } as DataNode
    })
  }, [filteredGroups, pickedNames])

  const checkedKeys = useMemo(() => {
    const out: string[] = []
    for (const g of filteredGroups) {
      const all = g.entries.length > 0 && g.entries.every(e => pickedNames.has(e.name))
      if (all) out.push(catKey(g.slug))
      for (const e of g.entries) {
        if (pickedNames.has(e.name)) out.push(agentKey(e.name))
      }
    }
    return out
  }, [filteredGroups, pickedNames])

  const expandedKeys = useMemo(
    () => filteredGroups.map(g => catKey(g.slug)),
    [filteredGroups],
  )

  const handleCheck = (
    _: unknown,
    info: { checked: boolean; node: any },
  ) => {
    const next = new Set(pickedNames)
    const node = info.node
    const key: string = node.key
    if (key.startsWith('cat:')) {
      const slug = key.slice('cat:'.length)
      const group = filteredGroups.find(g => g.slug === slug)
      if (!group) return
      if (info.checked) {
        for (const e of group.entries) next.add(e.name)
      } else {
        for (const e of group.entries) next.delete(e.name)
      }
    } else if (key.startsWith('agent:')) {
      const name = key.slice('agent:'.length)
      if (info.checked) next.add(name)
      else next.delete(name)
    }
    setPickedNames(next)
  }

  const selectAllVisible = () => {
    const next = new Set(pickedNames)
    for (const g of filteredGroups) for (const e of g.entries) next.add(e.name)
    setPickedNames(next)
  }

  const clearAll = () => setPickedNames(new Set())

  const apply = async () => {
    if (!pickerFor) return
    setBusy(pickerFor.id)
    try {
      // Send explicit `names`: empty array means "install nothing" (caller-driven uninstall).
      const res = await installTemplatePack(pickerFor.id, { names: Array.from(pickedNames) })
      message.success(t('settings:templatePacks.installedOk', { n: res.installed }))
      closePicker()
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

  // Summary counts the whole-pack selection, not just what's visible after a search.
  const summary = useMemo(() => {
    if (!pickerFor) return { cats: 0, agents: 0 }
    const cats = new Set<string>()
    for (const e of pickerFor.entries) {
      if (pickedNames.has(e.name)) cats.add(e.category)
    }
    return { cats: cats.size, agents: pickedNames.size }
  }, [pickerFor, pickedNames])

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
                  {p.installedCount > 0
                    ? <Tag color="green">{t('settings:templatePacks.installedCount', { n: p.installedCount })}</Tag>
                    : <Tag>{t('settings:templatePacks.availableCount', { n: p.entryCount })}</Tag>
                  }
                </Space>
                <Text type="secondary">{t(`${key}.desc` as any, '')}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('settings:templatePacks.attribution', { src: p.attribution, license: p.license })}
                </Text>
                {p.installedCount > 0 && (
                  <Space size={4} wrap>
                    {p.installedCategories.map(slug => {
                      const cat = p.categories.find(c => c.slug === slug)
                      return (
                        <Tag key={slug}>
                          {t(`settings:template.categoryLabels.${slug}` as any, slug as string)} · {cat?.count ?? '?'}
                        </Tag>
                      )
                    })}
                  </Space>
                )}
                <div>
                  <Space>
                    <Button
                      type={p.installedCount > 0 ? 'default' : 'primary'}
                      size="small"
                      loading={busy === p.id}
                      onClick={() => openPicker(p)}
                    >
                      {p.installedCount > 0
                        ? t('settings:templatePacks.adjust', { defaultValue: '调整选择' })
                        : t('settings:templatePacks.pick', { defaultValue: '选择员工' })}
                    </Button>
                    {p.installedCount > 0 && (
                      <Button
                        danger
                        size="small"
                        loading={busy === p.id}
                        onClick={() => onUninstall(p.id)}
                      >
                        {t('settings:templatePacks.uninstallAll', { defaultValue: '全部卸载' })}
                      </Button>
                    )}
                  </Space>
                </div>
              </Space>
            </Card>
          )
        })}
      </Space>

      <Modal
        open={!!pickerFor}
        onCancel={closePicker}
        onOk={apply}
        confirmLoading={busy === pickerFor?.id}
        title={t('settings:templatePacks.pickerTitle', { defaultValue: '选择员工' })}
        okText={t('settings:templatePacks.apply', { defaultValue: '应用' })}
        cancelText={t('settings:templatePacks.cancel', { defaultValue: '取消' })}
        width={640}
      >
        {pickerFor && (
          <div>
            <Space style={{ marginBottom: 8, width: '100%' }} direction="vertical">
              <Input.Search
                allowClear
                placeholder={t('settings:template.searchPlaceholder', { defaultValue: '搜索员工名 / 描述…' }) as string}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Space>
                <Button size="small" onClick={selectAllVisible}>
                  {t('settings:templatePacks.selectAll', { defaultValue: '全选' })}
                </Button>
                <Button size="small" onClick={clearAll}>
                  {t('settings:templatePacks.clearAll', { defaultValue: '清空' })}
                </Button>
              </Space>
            </Space>
            <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--ant-color-border, #f0f0f0)', borderRadius: 4, padding: 8 }}>
              {filteredGroups.length === 0 ? (
                <Empty description={t('settings:template.emptySearch', { defaultValue: '没有匹配的员工' }) as string} />
              ) : (
                <Tree
                  checkable
                  selectable={false}
                  treeData={treeData}
                  checkedKeys={checkedKeys}
                  expandedKeys={expandedKeys}
                  onCheck={handleCheck as any}
                  onExpand={() => { /* groups stay open by design */ }}
                />
              )}
            </div>
            <Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
              {t('settings:templatePacks.pickerSummary', {
                cats: summary.cats,
                agents: summary.agents,
                defaultValue: '已选 {{cats}} 个分类 / {{agents}} 个员工',
              })}
            </Paragraph>
          </div>
        )}
      </Modal>
    </div>
  )
}
