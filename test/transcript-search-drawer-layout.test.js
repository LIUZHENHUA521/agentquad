import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const source = fs.readFileSync(path.resolve('web/src/transcripts/TranscriptSearchDrawer.tsx'), 'utf8')

describe('TranscriptSearchDrawer layout regression', () => {
  it('keeps long bound todo tags from overflowing the drawer', () => {
    expect(source).toContain('Tooltip')
    expect(source).toContain('const ellipsisTagStyle')
    expect(source).toContain("maxWidth: '100%'")
    expect(source).toContain("overflow: 'hidden'")
    expect(source).toContain("textOverflow: 'ellipsis'")
    expect(source).toContain("whiteSpace: 'nowrap'")
    expect(source).toContain("minWidth: 0")
    expect(source).toContain('title={boundTodoTitle}')
    expect(source).toContain('style={ellipsisTagStyle}')
  })
})
