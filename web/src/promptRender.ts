import i18n from './i18n'
import type { Todo, PromptTemplate } from './api'

const QUADRANT_KEYS = {
  1: 'todo:quadrant.q1',
  2: 'todo:quadrant.q2',
  3: 'todo:quadrant.q3',
  4: 'todo:quadrant.q4',
} as const

function quadrantLabel(quadrant: number): string {
  const key = QUADRANT_KEYS[quadrant as keyof typeof QUADRANT_KEYS]
  return key ? i18n.t(key) : ''
}

export function buildVars(todo: Todo): Record<string, string> {
  const dueDate = todo.dueDate ? new Date(todo.dueDate).toISOString().slice(0, 10) : ''
  return {
    title: todo.title || '',
    description: todo.description || '',
    workDir: todo.workDir || '',
    quadrant: todo.quadrant
      ? i18n.t('todo:quadrantWithCode', { code: todo.quadrant, label: quadrantLabel(todo.quadrant) })
      : '',
    dueDate,
  }
}

export function renderTemplate(content: string, vars: Record<string, string>): string {
  if (!content) return ''
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars?.[key]
    return v == null ? '' : String(v)
  })
}

export function renderAppliedTemplates(
  todo: Todo,
  allTemplates: PromptTemplate[],
): string {
  const ids = todo.appliedTemplateIds || []
  if (!ids.length || !allTemplates?.length) return ''
  const vars = buildVars(todo)
  const byId = new Map(allTemplates.map(t => [t.id, t]))
  return ids
    .map(id => byId.get(id))
    .filter((t): t is PromptTemplate => !!t)
    .map(t => renderTemplate(t.content, vars).trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
}
