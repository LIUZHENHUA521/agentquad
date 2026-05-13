import type { Resources } from './zh-CN'

type DeepStringShape<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepStringShape<T[K]>
}

const en = {
  common: {
    confirm: 'OK',
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    restore: 'Restore',
    close: 'Close',
    edit: 'Edit',
    copy: 'Copy',
    refresh: 'Refresh',
    loading: 'Loading…',
    empty: 'No data',
    todo: 'Todo',
    done: 'Done',
    running: 'Running',
    idle: 'Idle',
    yes: 'Yes',
    no: 'No',
  },
  palette: {
    a11y: {
      commandPalette: 'Command Palette',
    },
    placeholder: 'Type a command or search a todo...',
    placeholderAi: 'Search a todo to start AI session ({{tool}})...',
    empty: {
      noResults: 'No results.',
      noTodos: 'No todos available — create one first.',
    },
    groups: {
      quickActions: 'Quick actions',
      jumpToTodo: 'Jump to todo',
      focusSession: 'Focus session',
      drawers: 'Drawers',
      view: 'View',
      system: 'System',
      recentTodos: 'Recent / Active todos',
    },
    actions: {
      createTodo: 'Create new todo',
      startAi: 'Start AI session ({{tool}}) →',
      pickTodoForAi: 'Start AI session — pick a todo ({{tool}})',
      backToDefault: 'Back',
      focusLabel: 'Focus: {{title}}',
      restoreToTodo: 'Restore to todo: {{label}}',
      openStatsReports: 'Open Stats & Reports',
      openWiki: 'Open Wiki',
      openSettings: 'Open Settings',
      openStats: 'Open Stats',
      insertFromTemplate: 'Insert from Template…',
      telegramSync: 'Telegram sync',
      showOnlyTodo: 'Show only todo',
      showOnlyDone: 'Show only done',
      showAll: 'Show all todos',
      toggleTheme: 'Toggle theme (dark / light)',
    },
    meta: {
      done: 'Done',
    },
    subtaskLabel: '↳ {{parent}} / {{title}}',
  },
  topbar: {},
  todo: {
    restoredToTodo: 'Restored to todo',
  },
  session: {},
  transcript: {},
  wiki: {},
  settings: {},
  errors: {
    restoreFailed: 'Restore failed',
  },
} as const satisfies DeepStringShape<Resources>

export default en
