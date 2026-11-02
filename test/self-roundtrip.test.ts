import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { loadSelf, resetSelfFiles, saveSelf, setSelfFiles, setSelfHistoryDir } from '../src/self/store.ts'

/**
 * self.md 的往返保真。
 *
 * 为什么值得测：saveSelf 是**按固定模板重写整个文件**的。
 * 只要 loadSelf 漏解析了某一段，下一次保存就会把那一段换成占位文字 ——
 * 用户的"我是谁/我能做什么/我最近在想"被静默清空，界面上只表现为
 * "我写的东西没了"，没有任何报错。
 *
 * 这类问题以前真的发生过（旧格式的 `我·xxx` 特征行被整段抹掉）。
 */

const dir = mkdtempSync(join(tmpdir(), 'qqbot-self-'))
setSelfHistoryDir(join(dir, 'history'))
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// 用例之间必须还原全局路径：否则会污染后面文件里的用例
afterEach(() => resetSelfFiles())

let seq = 0
/** 把一段 self.md 写进临时文件，返回路径 */
function useSelf(content: string): string {
  const p = join(dir, `self-${++seq}.md`)
  writeFileSync(p, content, 'utf8')
  // 必须**在每个用例里**设置，不能在模块顶层设：
  // `--test-isolation=none` 下所有测试共用一个进程，模块顶层的全局改动
  // 会漏到别的测试文件里（实测把 self.test.ts 的一条用例弄挂了）。
  setSelfFiles(p, join(dir, `life-${seq}.md`))
  setSelfHistoryDir(join(dir, 'history'))
  return p
}

const FULL = `---
名字: 小暮
所有权: 它写
取名原因: 觉得好听
---

# 我是谁

一个在群里待着的人，说话有点慢。

## 我能做什么

看群、记事情、陪聊。

## 我最近在想

为什么人总在半夜说话。
`

test('完整文件：load → save 一字不差', () => {
  const p = useSelf(FULL)
  saveSelf(loadSelf())
  assert.equal(readFileSync(p, 'utf8'), FULL)
})

test('三段内容都要真的读出来（不能被占位符替换）', () => {
  const p = useSelf(FULL)
  const doc = loadSelf()
  assert.match(doc.about, /说话有点慢/)
  assert.match(doc.abilities, /记事情/)
  assert.match(doc.thinking, /半夜说话/)
  saveSelf(doc)
  const after = readFileSync(p, 'utf8')
  assert.equal(after.includes('（还没盘点过。）'), false, '不能把「我能做什么」写成占位符')
  assert.equal(after.includes('（还没有。）'), false, '不能把「我最近在想」写成占位符')
})

test('「我写」模式下，它补充的那段要保住', () => {
  const src = `---
名字: 小暮
所有权: 我写
取名原因: 
---

# 我是谁

我自己写的。

## 它补充的

它悄悄加的一句。

## 我能做什么

聊天。

## 我最近在想

在想。
`
  const p = useSelf(src)
  saveSelf(loadSelf())
  const after = readFileSync(p, 'utf8')
  assert.ok(after.includes('它悄悄加的一句'), '补充段落不能丢')
  assert.ok(after.includes('我自己写的'))
})

test('「它写」模式：不该凭空长出「它补充的」段落', () => {
  const p = useSelf(FULL)
  saveSelf(loadSelf())
  assert.equal(readFileSync(p, 'utf8').includes('## 它补充的'), false)
})

test('没有 frontmatter 的老文件：也不崩，且不会把正文丢掉', () => {
  const src = `# 我是谁\n\n老格式，没有 frontmatter。\n`
  const p = useSelf(src)
  const doc = loadSelf()
  assert.match(doc.about, /老格式/)
  saveSelf(doc)
  assert.match(readFileSync(p, 'utf8'), /老格式/)
})

test('空文件：写出来的是一份能看的东西，不是空串', () => {
  const p = useSelf('')
  saveSelf(loadSelf())
  const after = readFileSync(p, 'utf8')
  assert.ok(after.includes('# 我是谁'))
  assert.ok(after.length > 20)
})

test('每次保存都留一份历史快照（人格漂了能回看）', () => {
  useSelf(FULL)
  saveSelf({ ...loadSelf(), about: '改了一版。' })
  saveSelf({ ...loadSelf(), about: '又改了一版。' })
  const hist = join(dir, 'history')
  assert.ok(readdirSync(hist).length >= 1, '历史快照没写出来')
})
