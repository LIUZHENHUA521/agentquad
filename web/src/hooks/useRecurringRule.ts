import { useState, useCallback } from 'react'
import { Form, type FormInstance } from 'antd'
import {
  getRecurringRule,
  updateRecurringRule,
  deactivateRecurringRule,
  type RecurringRule,
  type RecurringFrequency,
} from '../api'

/**
 * Recurring-rule editing & detail-drawer subsystem.
 *
 * Encapsulates:
 *   - the rule shown next to the todo in the detail drawer (`detailRule`,
 *     plus the helper to load it for a given ruleId)
 *   - the rule edit Modal (open/editing/form state, openEdit, save)
 *   - the stop-rule action
 *   - the human-readable describe helper
 *
 * `save` and `stop` re-throw on failure so the caller controls toast UX —
 * with one exception: antd Form validation errors carry an `errorFields`
 * property and are intentionally swallowed here (matches the pre-extraction
 * behaviour where the inline handler returned silently for them).
 */
export function useRecurringRule() {
  const [detailRule, setDetailRule] = useState<RecurringRule | null>(null)
  const [ruleModalOpen, setRuleModalOpen] = useState(false)
  const [ruleEditing, setRuleEditing] = useState<RecurringRule | null>(null)
  const [ruleForm] = Form.useForm()

  /**
   * Load (or clear) the rule shown beside the todo in the detail drawer.
   * Pass the ruleId from the todo, or `null` to clear.
   */
  const loadDetailRule = useCallback((ruleId: string | null) => {
    if (!ruleId) { setDetailRule(null); return }
    setDetailRule(null)
    getRecurringRule(ruleId).then(setDetailRule).catch(() => {})
  }, [])

  const describeRule = useCallback((r: RecurringRule) => {
    if (r.frequency === 'daily') return '每天重复'
    if (r.frequency === 'weekly') {
      const names = ['日', '一', '二', '三', '四', '五', '六']
      return '每周 ' + (r.weekdays || []).map(w => names[w]).join('、')
    }
    if (r.frequency === 'monthly') {
      return '每月 ' + (r.monthDays || []).join('、') + ' 号'
    }
    return '重复'
  }, [])

  const openRuleEdit = useCallback((rule: RecurringRule) => {
    setRuleEditing(rule)
    ruleForm.resetFields()
    ruleForm.setFieldsValue({
      title: rule.title,
      description: rule.description,
      frequency: rule.frequency,
      weekdays: rule.weekdays.length ? rule.weekdays : [1, 2, 3, 4, 5],
      monthDays: rule.monthDays.length ? rule.monthDays : [1],
    })
    setRuleModalOpen(true)
  }, [ruleForm])

  const closeRuleEdit = useCallback(() => {
    setRuleModalOpen(false)
    setRuleEditing(null)
  }, [])

  /**
   * Validate + persist the editing rule. Returns a status:
   *   - 'ok': saved
   *   - 'invalid': caller-visible validation error (toast a message)
   *   - 'noop': nothing to save / Form-level validation failure (silent)
   * On other errors, throws.
   */
  const saveRule = useCallback(async (): Promise<
    | { status: 'ok' }
    | { status: 'invalid'; reason: string }
    | { status: 'noop' }
  > => {
    if (!ruleEditing) return { status: 'noop' }
    let values: any
    try {
      values = await ruleForm.validateFields()
    } catch {
      return { status: 'noop' }
    }
    const frequency = values.frequency as RecurringFrequency
    if (frequency === 'weekly' && !(values.weekdays || []).length) {
      return { status: 'invalid', reason: '请至少选择一个星期几' }
    }
    if (frequency === 'monthly' && !(values.monthDays || []).length) {
      return { status: 'invalid', reason: '请至少选择一个月内日期' }
    }
    const next = await updateRecurringRule(ruleEditing.id, {
      title: values.title,
      description: values.description || '',
      frequency,
      weekdays: frequency === 'weekly' ? values.weekdays : [],
      monthDays: frequency === 'monthly' ? values.monthDays : [],
    })
    setRuleModalOpen(false)
    setRuleEditing(null)
    setDetailRule(prev => prev && prev.id === next.id ? next : prev)
    return { status: 'ok' }
  }, [ruleEditing, ruleForm])

  const stopRule = useCallback(async (ruleId: string) => {
    await deactivateRecurringRule(ruleId)
    setDetailRule(prev => prev && prev.id === ruleId ? { ...prev, active: false } : prev)
  }, [])

  return {
    // Detail-drawer rule
    detailRule,
    loadDetailRule,
    describeRule,
    // Modal
    ruleModalOpen,
    ruleEditing,
    ruleForm: ruleForm as FormInstance,
    openRuleEdit,
    closeRuleEdit,
    saveRule,
    stopRule,
  }
}
