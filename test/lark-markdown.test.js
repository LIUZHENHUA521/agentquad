import { describe, expect, it } from 'vitest'
import { toLarkText } from '../src/lark-markdown.js'

describe('toLarkText', () => {
  it('strips heading prefixes', () => {
    expect(toLarkText('# 一级\n## 二级\n### 三级')).toBe('一级\n二级\n三级')
  })

  it('strips bold and italic', () => {
    expect(toLarkText('这是 **粗体** 和 __粗体2__ 还有 *斜体* 和 _斜体2_')).toBe('这是 粗体 和 粗体2 还有 斜体 和 斜体2')
  })

  it('keeps list bullets after stripping italic', () => {
    expect(toLarkText('- 项一\n- 项二\n* 项三')).toBe('- 项一\n- 项二\n* 项三')
  })

  it('strips strikethrough', () => {
    expect(toLarkText('已完成的 ~~旧方案~~ 留 ~新方案~ 不要碰')).toBe('已完成的 旧方案 留 ~新方案~ 不要碰')
  })

  it('strips blockquotes', () => {
    expect(toLarkText('> 引用一行\n> 又一行\n下面正文')).toBe('引用一行\n又一行\n下面正文')
  })

  it('rewrites links to "label (url)" and collapses identical label/url', () => {
    expect(toLarkText('看 [飞书文档](https://open.feishu.cn) 和 [https://github.com](https://github.com)'))
      .toBe('看 飞书文档 (https://open.feishu.cn) 和 https://github.com')
  })

  it('drops images entirely', () => {
    expect(toLarkText('前 ![alt](https://x/y.png) 后')).toBe('前  后')
  })

  it('removes code fence markers but keeps content', () => {
    const md = '```js\nconsole.log(1)\n```\n```\nplain\n```'
    expect(toLarkText(md)).toBe('console.log(1)\n\nplain\n')
  })

  it('keeps inline backticks for visual cue', () => {
    expect(toLarkText('用 `npm test` 跑')).toBe('用 `npm test` 跑')
  })

  it('replaces horizontal rules with em-dashes', () => {
    expect(toLarkText('上\n---\n下')).toBe('上\n——————————\n下')
    expect(toLarkText('上\n***\n下')).toBe('上\n——————————\n下')
  })

  it('unescapes backslash-escaped markdown punctuation', () => {
    expect(toLarkText('这是 \\*星号\\* 和 \\#井号')).toBe('这是 *星号* 和 #井号')
  })

  it('returns empty string for null / undefined', () => {
    expect(toLarkText(null)).toBe('')
    expect(toLarkText(undefined)).toBe('')
  })

  it('passes plain Chinese text through unchanged', () => {
    expect(toLarkText('帮我做一个登录页')).toBe('帮我做一个登录页')
  })

  it('handles a realistic mixed markdown blob', () => {
    const md = [
      '## 测试报告',
      '',
      '**总结**：3 个用例 *全部通过* ✅',
      '',
      '- [x] case A',
      '- [x] case B',
      '',
      '查看 [详情](https://example.test/report)。',
      '',
      '```bash',
      'npm test',
      '```',
    ].join('\n')
    expect(toLarkText(md)).toBe([
      '测试报告',
      '',
      '总结：3 个用例 全部通过 ✅',
      '',
      '- [x] case A',
      '- [x] case B',
      '',
      '查看 详情 (https://example.test/report)。',
      '',
      'npm test',
      '',
    ].join('\n'))
  })
})
