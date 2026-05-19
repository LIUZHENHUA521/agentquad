// 把 templates 按 category 分组成 Antd Select 的 grouped options。
// 之所以集中在一个 util，是因为多个 Select 站点（SettingsDrawer 默认派活、
// TodoManage 新建/编辑表单里的"指派 Agent"）要共用同一份分组 + 搜索逻辑——
// 184+ entries 不分组不搜索就是个滚轮地狱。
import type { PromptTemplate } from './api'

// 跟 useTranslation()['t'] 兼容，避免硬依赖 i18next 的 TFunction 类型——
// 这边只用到 (key, fallback?) 这一种签名。
type Translator = (key: string, fallback?: string) => string

export interface GroupedTemplateOption {
  label: string
  title: string
  options: Array<{
    value: string
    label: string
    // Antd filterOption 拿到 option 时 label 可能是 ReactNode；
    // 在这里固化一份纯文本 haystack 给 filterOption 用，比每次再 stringify 稳。
    _searchHaystack: string
  }>
}

export function templatesToGroupedOptions(
  templates: PromptTemplate[],
  t: Translator,
): GroupedTemplateOption[] {
  const byCat = new Map<string, PromptTemplate[]>()
  for (const tpl of templates) {
    const k = tpl.category || 'none'
    if (!byCat.has(k)) byCat.set(k, [])
    byCat.get(k)!.push(tpl)
  }
  return [...byCat.entries()]
    .sort(([a], [b]) => {
      // "none" = 核心未分类，永远置顶；其余按 slug 字典序。
      if (a === 'none') return -1
      if (b === 'none') return 1
      return a.localeCompare(b)
    })
    .map(([cat, items]) => ({
      label: t(`settings:template.categoryLabels.${cat}`, cat),
      title: cat,
      options: items.map((tpl) => ({
        value: tpl.id,
        label: tpl.name,
        _searchHaystack: `${tpl.name} ${tpl.description || ''}`.toLowerCase(),
      })),
    }))
}

// Antd Select 的 filterOption：grouped options 时只对 leaf option 调用，
// option 形参拿到的是 leaf（带 _searchHaystack）。
export function templateFilterOption(input: string, option: any): boolean {
  const q = (input || '').trim().toLowerCase()
  if (!q) return true
  const hay = option?._searchHaystack || option?.label || ''
  return String(hay).toLowerCase().includes(q)
}
