import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'src/cli.js')

function run(args) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('cli agents', () => {
  it('agents --help lists install/uninstall/status', () => {
    const r = run(['agents', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/install/)
    expect(r.stdout).toMatch(/uninstall/)
    expect(r.stdout).toMatch(/status/)
  })

  it('agents install --dry-run --target claude does not crash (smoke)', () => {
    const r = run(['agents', 'install', '--dry-run', '--target', 'claude'])
    expect(r.code).toBe(0)
    expect(r.stdout.toLowerCase()).toMatch(/dry-run|preview|changes|already/i)
  })

  it('agents status runs without error', () => {
    const r = run(['agents', 'status'])
    expect(r.code).toBe(0)
  })
})
