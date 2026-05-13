import type { Resources } from './zh-CN'

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
  palette: {},
  topbar: {},
  todo: {},
  session: {},
  transcript: {},
  wiki: {},
  settings: {},
  errors: {},
} as const satisfies { [K in keyof Resources]: Record<keyof Resources[K], string> }

export default en
