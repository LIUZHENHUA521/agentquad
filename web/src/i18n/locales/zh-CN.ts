const zh = {
  common: {
    confirm: '确定',
    cancel: '取消',
    save: '保存',
    delete: '删除',
    restore: '恢复',
    close: '关闭',
    edit: '编辑',
    copy: '复制',
    refresh: '刷新',
    loading: '加载中…',
    empty: '暂无数据',
    todo: '待办',
    done: '已完成',
    running: '运行中',
    idle: '空闲',
    yes: '是',
    no: '否',
  },
  palette: {},
  topbar: {},
  todo: {},
  session: {},
  transcript: {},
  wiki: {},
  settings: {},
  errors: {},
} as const

export default zh
export type Resources = typeof zh
