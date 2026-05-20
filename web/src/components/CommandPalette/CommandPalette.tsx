import { useState, useEffect, useMemo } from 'react'
import { Command } from 'cmdk'
import { useTranslation } from 'react-i18next'
import { useDispatchStore } from '../../store/dispatchStore'
import { useTheme } from '../../design/ThemeProvider'
import { useAiSessionStore } from '../../store/aiSessionStore'
import { listTodos, updateTodo, type Todo, type TranscriptFile } from '../../api'
import { useAppMessages } from '../../design/useAppMessages'
import { BarChart3, BookOpen, Settings, BarChartBig, Bot, Send, Moon } from 'lucide-react'
import { TranscriptResultsGroup } from './TranscriptResultsGroup'
import BindTodoModal from '../../transcripts/BindTodoModal'
import './CommandPalette.css'

interface TodoEntry {
  id: string
  sessionId: string
  title: string
  status?: string
  tool?: string
  quad?: number | string
}

const JUMP_LIST_EMPTY_LIMIT = 20

export function CommandPalette() {
  const { t } = useTranslation(['palette', 'todo', 'errors'])
  const open = useDispatchStore((s) => s.palette)
  const closePalette = useDispatchStore((s) => s.closePalette)
  const openDrawer = useDispatchStore((s) => s.openDrawer)
  const { toggle: toggleTheme } = useTheme()
  const { message } = useAppMessages()

  const [search, setSearch] = useState('')
  const [allTodos, setAllTodos] = useState<Todo[]>([])
  // 未绑定的 transcript 命中:命令面板关掉,弹这个 modal 让用户选 todo
  const [bindTarget, setBindTarget] = useState<{ file: TranscriptFile; query: string } | null>(null)

  useEffect(() => {
    if (open) {
      setSearch('')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    listTodos({}).then((list) => {
      if (!cancelled) setAllTodos(list)
    }).catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [open])

  const sessions = useAiSessionStore((s) => s.sessions)

  const parentTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const todo of allTodos) if (!todo.parentId) map.set(todo.id, todo.title)
    return map
  }, [allTodos])

  const jumpListTodos = useMemo(() => {
    if (search.trim()) return allTodos
    return [...allTodos]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, JUMP_LIST_EMPTY_LIMIT)
  }, [allTodos, search])

  function jumpToTodo(todo: Todo) {
    if (todo.status === 'done') {
      useDispatchStore.getState().setBoardFilter('all')
    }
    useDispatchStore.getState().setJumpTo(todo.id)
    closePalette()
  }

  async function restoreTodo(todo: Todo) {
    closePalette()
    try {
      await updateTodo(todo.id, { status: 'todo' })
      useDispatchStore.getState().setBoardFilter('todo')
      useDispatchStore.getState().signal('refreshTodos')
      useDispatchStore.getState().setJumpTo(todo.id)
      message.success(t('todo:restoredToTodo'))
    } catch (e: any) {
      message.error(e?.message || t('errors:restoreFailed'))
    }
  }

  // transcript 命中 + 已绑定 todo → 找出 todo 上对应的 sessionId(by nativeSessionId),跳 SessionFocus
  function jumpToTranscript(file: TranscriptFile, query: string) {
    const todoId = file.bound_todo_id
    if (!todoId) return
    const todo = allTodos.find(td => td.id === todoId)
    if (!todo) {
      // 绑定到了归档 / 不可见的 todo,这里不静默吞掉
      message.warning(t('palette:transcript.noBoundTodo'))
      return
    }
    let sessionId: string | null = null
    for (const s of (todo.aiSessions || [])) {
      if (s.nativeSessionId === file.native_id && s.tool === file.tool) { sessionId = s.sessionId; break }
    }
    if (!sessionId && todo.aiSession?.nativeSessionId === file.native_id) sessionId = todo.aiSession.sessionId
    useDispatchStore.getState().openFocus(todoId, sessionId, { initialKeyword: query, initialTab: 'conversation' })
  }

  const seenTodoIds = new Set<string>()
  const todos: TodoEntry[] = []
  sessions.forEach((s) => {
    const id = s.todoId ?? s.sessionId
    if (!id || seenTodoIds.has(id)) return
    seenTodoIds.add(id)
    todos.push({
      id,
      sessionId: s.sessionId,
      title: s.todoTitle,
      status: s.status,
      tool: s.tool,
      quad: s.quadrant,
    })
  })

  // BindTodoModal 必须独立于 cmdk-overlay 渲染:onPickUnbound 时 palette 已关掉,但 modal 还要继续显示。
  const bindModalNode = (
    <BindTodoModal
      open={!!bindTarget}
      file={bindTarget?.file ?? null}
      todos={allTodos}
      onClose={() => setBindTarget(null)}
      onBound={async (todoId, file) => {
        const query = bindTarget?.query || ''
        setBindTarget(null)
        // 绑定后端已经把 native_id 写到 todo.aiSessions[*].nativeSessionId,但前端 allTodos 是旧的。
        // 重新拉一次拿到 sessionId 才能让 SessionFocus 渲染对应 transcript;失败就降级到 openFocus(todoId, null)。
        let sessionId: string | null = null
        try {
          const fresh = await listTodos({})
          setAllTodos(fresh)
          const todo = fresh.find(td => td.id === todoId)
          for (const s of (todo?.aiSessions || [])) {
            if (s.nativeSessionId === file.native_id && s.tool === file.tool) { sessionId = s.sessionId; break }
          }
          if (!sessionId && todo?.aiSession?.nativeSessionId === file.native_id) sessionId = todo.aiSession.sessionId
        } catch { /* fall through with sessionId=null */ }
        useDispatchStore.getState().openFocus(todoId, sessionId, { initialKeyword: query, initialTab: 'conversation' })
      }}
    />
  )

  if (!open) return bindModalNode

  return (
    <>
    <div
      className="cmdk-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) closePalette()
      }}
    >
      <Command
        label={t('palette:a11y.commandPalette')}
        className="cmdk-root"
      >
        <div className="cmdk-input-wrap">
          <span className="cmdk-prefix">⌘</span>
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder={t('palette:placeholder')}
            autoFocus
          />
          <kbd>esc</kbd>
        </div>

        <Command.List className="cmdk-list">
          <Command.Empty className="cmdk-empty">{t('palette:empty.noResults')}</Command.Empty>

          <Command.Group heading={t('palette:groups.quickActions')}>
            <Command.Item onSelect={() => {
              useDispatchStore.getState().signal('newTodo')
              closePalette()
            }}>
              <span className="cmdk-icon">+</span>
              <span>{t('palette:actions.createTodo')}</span>
              <span className="cmdk-meta">N</span>
            </Command.Item>
          </Command.Group>

          {jumpListTodos.length > 0 && (
            <Command.Group heading={t('palette:groups.jumpToTodo')}>
              {jumpListTodos.flatMap((todo) => {
                const isDone = todo.status === 'done'
                const parentTitle = todo.parentId ? parentTitleById.get(todo.parentId) : null
                const label = parentTitle
                  ? t('palette:subtaskLabel', { parent: parentTitle, title: todo.title })
                  : todo.title
                const jumpItem = (
                  <Command.Item
                    key={`todo-${todo.id}`}
                    value={`todo-${todo.id}-${label}`}
                    onSelect={() => jumpToTodo(todo)}
                  >
                    <span className="cmdk-icon" style={{ color: 'var(--accent-electric)' }}>
                      {isDone ? '↗' : '›'}
                    </span>
                    <span>{label}</span>
                    {isDone && <span className="cmdk-meta">{t('palette:meta.done')}</span>}
                  </Command.Item>
                )
                if (!isDone) return [jumpItem]
                return [
                  jumpItem,
                  <Command.Item
                    key={`restore-${todo.id}`}
                    value={`restore-${todo.id}-${label}`}
                    onSelect={() => restoreTodo(todo)}
                  >
                    <span className="cmdk-icon">↺</span>
                    <span>{t('palette:actions.restoreToTodo', { label })}</span>
                  </Command.Item>,
                ]
              })}
            </Command.Group>
          )}

          {todos.length > 0 && (
            <Command.Group heading={t('palette:groups.focusSession')}>
              {todos.map((todo) => (
                <Command.Item
                  key={`focus-${todo.id}`}
                  value={`focus-${todo.id}-${todo.title}`}
                  onSelect={() => {
                    useDispatchStore.getState().openFocus(todo.id, todo.sessionId)
                    closePalette()
                  }}
                >
                  <span className="cmdk-icon">⇆</span>
                  <span>{t('palette:actions.focusLabel', { title: todo.title })}</span>
                  {todo.tool && <span className="cmdk-meta">{todo.tool}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <TranscriptResultsGroup
            query={search}
            onPickBound={(file, q) => { jumpToTranscript(file, q) }}
            onPickUnbound={(file, q) => {
              closePalette()
              setBindTarget({ file, query: q })
            }}
          />

          <Command.Group heading={t('palette:groups.drawers')}>
            <Command.Item onSelect={() => { openDrawer('report'); closePalette() }}>
              <span className="cmdk-icon"><BarChart3 size={14} /></span>
              <span>{t('palette:actions.openStatsReports')}</span>
            </Command.Item>
            {/* 记忆 wiki 入口暂时隐藏，待重新设计后再开放
            <Command.Item onSelect={() => { openDrawer('wiki'); closePalette() }}>
              <span className="cmdk-icon"><BookOpen size={14} /></span>
              <span>{t('palette:actions.openWiki')}</span>
            </Command.Item>
            */}
            <Command.Item onSelect={() => { openDrawer('settings'); closePalette() }}>
              <span className="cmdk-icon"><Settings size={14} /></span>
              <span>{t('palette:actions.openSettings')}</span>
            </Command.Item>
            <Command.Item onSelect={() => { openDrawer('statsReports'); closePalette() }}>
              <span className="cmdk-icon"><BarChartBig size={14} /></span>
              <span>{t('palette:actions.openStats')}</span>
            </Command.Item>
            <Command.Item onSelect={() => { openDrawer('template'); closePalette() }}>
              <span className="cmdk-icon"><Bot size={14} /></span>
              <span>{t('palette:actions.insertFromTemplate')}</span>
            </Command.Item>
            <Command.Item onSelect={() => { useDispatchStore.getState().signal('telegramSync'); closePalette() }}>
              <span className="cmdk-icon"><Send size={14} /></span>
              <span>{t('palette:actions.telegramSync')}</span>
            </Command.Item>
          </Command.Group>

          <Command.Group heading={t('palette:groups.view')}>
            <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('todo'); closePalette() }}>
              <span className="cmdk-icon">●</span>
              <span>{t('palette:actions.showOnlyTodo')}</span>
            </Command.Item>
            <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('done'); closePalette() }}>
              <span className="cmdk-icon">✓</span>
              <span>{t('palette:actions.showOnlyDone')}</span>
            </Command.Item>
            <Command.Item onSelect={() => { useDispatchStore.getState().setBoardFilter('all'); closePalette() }}>
              <span className="cmdk-icon">∗</span>
              <span>{t('palette:actions.showAll')}</span>
            </Command.Item>
          </Command.Group>

          <Command.Group heading={t('palette:groups.system')}>
            <Command.Item onSelect={() => { toggleTheme(); closePalette() }}>
              <span className="cmdk-icon"><Moon size={14} /></span>
              <span>{t('palette:actions.toggleTheme')}</span>
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
    {bindModalNode}
    </>
  )
}
