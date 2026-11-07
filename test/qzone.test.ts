/**
 * 说说草稿的解析（B-41）。
 *
 * 这些断言来自一次真实演练：把真实的 `persona/qzone-draft.md`（旧格式）
 * 读进来、写回去、再读，两次往返都对得上，但**正文里含 `---` 的那条**
 * 读回来只剩前半段 —— 原因是两种分隔符混在同一个正则里。
 * 所以这里专门锁住这个场景。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMarkdown } from '../src/outward/qzone.ts'

test('旧格式：--- 分隔能读出来', () => {
  const text = [
    '# 想说说的草稿',
    '',
    '## 2026-10-25 01:20',
    '- 为什么想发：自己想发的',
    '第一段正文',
    '',
    '---',
    '',
    '## 2026-10-25 09:20',
    '第二段正文',
    '',
  ].join('\n')
  const r = parseMarkdown(text)
  assert.equal(r.drafts.length, 2)
  assert.equal(r.drafts[0]!.content, '第一段正文')
  assert.equal(r.drafts[1]!.content, '第二段正文')
})

test('新格式：<!-- draft --> 分隔能读出来', () => {
  const text = [
    '# 想说说的草稿',
    '',
    '## 2026-10-25 01:20',
    '第一段正文',
    '',
    '<!-- draft -->',
    '',
    '## 2026-10-25 09:20',
    '第二段正文',
    '',
  ].join('\n')
  const r = parseMarkdown(text)
  assert.equal(r.drafts.length, 2)
  assert.equal(r.drafts[0]!.content, '第一段正文')
})

test('新格式文件里正文含 --- 不会被切断', () => {
  // 这条是真实踩到的：同样的正文，混用一个正则时只剩「第一段」
  const text = [
    '# 想说说的草稿',
    '',
    '## 2026-10-25 01:20',
    '第一段',
    '',
    '---',
    '',
    '第二段，这条正文里有一行分隔线',
    '',
    '<!-- draft -->',
    '',
    '## 2026-10-25 09:20',
    '另一条',
    '',
  ].join('\n')
  const r = parseMarkdown(text)
  assert.equal(r.drafts.length, 2)
  assert.equal(r.drafts[0]!.content, '第一段\n\n---\n\n第二段，这条正文里有一行分隔线')
})

test('已发的条目进 published，不再算草稿', () => {
  const text = [
    '# 想说说的草稿',
    '',
    '## 2026-10-25 01:20 [已发 abc123]',
    '已经发出去的正文',
    '',
    '<!-- draft -->',
    '',
    '## 2026-10-25 09:20',
    '还没发的正文',
    '',
  ].join('\n')
  const r = parseMarkdown(text)
  assert.equal(r.drafts.length, 1)
  assert.equal(r.drafts[0]!.content, '还没发的正文')
  assert.equal(r.published.length, 1)
  assert.equal(r.published[0]!.tid, 'abc123')
})

test('为什么想发 / 图片 这两行不进正文', () => {
  const text = [
    '# 想说说的草稿',
    '',
    '## 2026-10-25 01:20',
    '- 为什么想发：憋了一天了',
    '- 图片：a.png, b.png',
    '正文在最后',
    '',
  ].join('\n')
  const r = parseMarkdown(text)
  assert.equal(r.drafts.length, 1)
  assert.equal(r.drafts[0]!.content, '正文在最后')
  assert.deepEqual(r.drafts[0]!.images, ['a.png', 'b.png'])
  assert.equal(r.drafts[0]!.reason, '憋了一天了')
})
