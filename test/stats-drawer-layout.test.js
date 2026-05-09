import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve('web/src/StatsDrawer.tsx'), 'utf8')

describe('StatsDrawer layout regression', () => {
  it('keeps drawer content within the viewport and lets dense tables scroll inside the drawer', () => {
    expect(source).toContain('width="min(720px, 100vw)"')
    expect(source).toContain("overflowX: 'hidden'")
    expect(source).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))'")
    expect(source).toContain("scroll={{ x: 'max-content' }}")
    expect(source).toContain('ellipsis: true')
  })

  it('formats duration chart values as hours in tooltip and y axis', () => {
    expect(source).toContain("const fmtChartHours = (hours: number) => `${hours.toFixed(1)}h`")
    expect(source).toContain("axis={{ y: { labelFormatter: fmtChartHours } }}")
    expect(source).toContain("tooltip={{ items: [{ channel: 'y', valueFormatter: fmtChartHours }] }}")
  })
})
