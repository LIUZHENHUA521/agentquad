import { useEffect, useMemo, useState } from 'react'
import { Modal, Select } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAppMessages } from '../design/useAppMessages'
import { bindTranscript, type TranscriptFile, type Todo } from '../api'

type Props = {
  open: boolean
  file: TranscriptFile | null
  todos: Todo[]
  preselectTodoId?: string | null
  onClose: () => void
  /**
   * 绑定成功(含 force=true 覆盖冲突后)的回调。失败 / 取消不触发。
   * 父组件可以在此刷新列表 / 跳转 / 提示。
   */
  onBound: (todoId: string, file: TranscriptFile) => void
}

export default function BindTodoModal({ open, file, todos, preselectTodoId, onClose, onBound }: Props) {
  const { t } = useTranslation(['transcript', 'errors'])
  const { message, modal } = useAppMessages()
  const [bindTodoId, setBindTodoId] = useState<string>('')

  useEffect(() => {
    if (open && preselectTodoId) setBindTodoId(preselectTodoId)
    if (!open) setBindTodoId('')
  }, [open, preselectTodoId])

  async function submitBind(force = false) {
    if (!file || !bindTodoId) return
    try {
      const r = await bindTranscript(file.id, bindTodoId, force)
      if (r.conflict) {
        const other = todos.find(td => td.id === r.currentTodoId)
        modal.confirm({
          title: t('transcript:searchDrawer.conflictTitle'),
          content: t('transcript:searchDrawer.conflictContent', { title: other?.title || r.currentTodoId }),
          okText: t('transcript:searchDrawer.conflictOk'),
          onOk: async () => submitBind(true),
        })
        return
      }
      message.success(t('transcript:searchDrawer.bound'))
      const boundTodoId = bindTodoId
      setBindTodoId('')
      onBound(boundTodoId, file)
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const todoOptions = useMemo(() => todos.map(td => ({ label: td.title, value: td.id })), [todos])

  return (
    <Modal
      open={open}
      title={t('transcript:searchDrawer.bindModalTitle')}
      onCancel={onClose}
      onOk={() => submitBind(false)}
      okButtonProps={{ disabled: !bindTodoId }}
    >
      <Select
        showSearch
        style={{ width: '100%' }}
        placeholder={t('transcript:searchDrawer.pickTodoPlaceholder')}
        value={bindTodoId || undefined}
        onChange={setBindTodoId}
        filterOption={(input, option) => String(option?.label || '').toLowerCase().includes(input.toLowerCase())}
        options={todoOptions}
      />
    </Modal>
  )
}
