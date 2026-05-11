export type ResumeTool = 'claude' | 'codex' | 'cursor'

const BIN: Record<ResumeTool, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor-agent',
}

export function posixEscape(s: string): string {
  // POSIX single-quote rule: a single quote inside a single-quoted string
  // must be closed, escaped with backslash, and reopened: '...'\''...'.
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export function buildResumeCommand(input: {
  tool: ResumeTool
  native_id: string
  cwd: string | null
}): { command: string; warnings: string[] } {
  const { tool, native_id, cwd } = input
  if (!BIN[tool]) {
    throw new Error(`unsupported tool: ${tool}`)
  }
  if (!native_id) {
    throw new Error('native_id is required')
  }
  const bin = BIN[tool]
  const resumeFlag = tool === 'codex' ? 'resume' : '--resume'
  const tail = `${bin} ${resumeFlag} ${posixEscape(native_id)}`

  const warnings: string[] = []
  if (!cwd) {
    warnings.push('cwd_missing')
    return { command: tail, warnings }
  }
  return { command: `cd ${posixEscape(cwd)} && ${tail}`, warnings }
}
