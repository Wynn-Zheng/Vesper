/**
 * 写印象不该刷新"意愿的时间"。
 *
 * 背景（B-25）：setImpression 以前把 w.at 刷成 Date.now()，而 at 是
 * 「今天这份意愿什么时候定的」—— willFresh() 按它算 age，过期与衰减都看它。
 * 结果只要还在聊天、还在反思，意愿就永远不会过期，整套机制被取消了。
 *
 * 隔离要点（踩过坑）：
 *   1. currentCardId() 要求 cardsRoot/<id>.md 真的存在，否则 cardScopedPath 退回
 *      persona/will.json 这个全局 legacy 路径，测试会写坏真实数据；
 *   2. --test-isolation=none 下全局 root 会被别的测试文件改回去，所以每次用唯一
 *      personId，并在 finally 里两个位置（临时根 + 真实根）都清一遍。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetCardCache, setCardsRoot } from '../src/persona/card.ts'
import { setPeopleRoot } from '../src/people/store.ts'
import { loadWill, saveWill, setImpression } from '../src/self/will.ts'

let UID = ''

function withTempCards(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'vesper-will-'))
  const card = 'testcard'
  mkdirSync(join(dir, card), { recursive: true })
  writeFileSync(join(dir, `${card}.md`), '# 测试卡\n', 'utf8')
  writeFileSync(join(dir, 'current.txt'), card, 'utf8')
  UID = `test-${process.pid}-${Date.now()}`
  setCardsRoot(dir)
  resetCardCache()
  setPeopleRoot(join(dir, 'people'))
  try {
    fn(dir)
  } finally {
    setCardsRoot('persona/cards')
    resetCardCache()
    setPeopleRoot('persona/people')
    // 兜底：即便中途 root 被别的测试改回真实路径，也不在 persona/people 里留孤儿
    for (const p of [
      join(dir, 'people', UID),
      join(dir, 'people', `${UID}-a`),
      join(dir, 'people', `${UID}-b`),
      join('persona', 'people', UID),
      join('persona', 'people', `${UID}-a`),
      join('persona', 'people', `${UID}-b`),
    ]) {
      rmSync(p, { recursive: true, force: true })
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test('写印象之后 at 不变，只更新 editedAt', () => {
  withTempCards(() => {
    const fixedAt = 1_700_000_000_000
    saveWill({
      at: fixedAt,
      talk: true,
      talkReason: '今天想说话',
      watch: false,
      watchReason: '',
      impressions: {},
    })

    setImpression(UID, '他最近在忙答辩')

    const after = loadWill()
    assert.equal(after.at, fixedAt, 'at 是「意愿什么时候定的」，不该被印象刷新')
    assert.equal(after.impressions[UID], '他最近在忙答辩')
    assert.ok((after.editedAt ?? 0) > fixedAt, 'editedAt 应该更新到现在')
  })
})

test('老文件没有 editedAt 时回落到 at，不是 0', () => {
  withTempCards((dir) => {
    const legacyAt = 1_600_000_000_000
    writeFileSync(
      join(dir, 'testcard', 'will.json'),
      JSON.stringify({ at: legacyAt, talk: false, talkReason: '', watch: false, watchReason: '', impressions: {} }),
      'utf8',
    )
    const w = loadWill()
    assert.equal(w.at, legacyAt)
    assert.equal(w.editedAt, legacyAt, '缺字段时沿用 at，避免显示成 1970')
  })
})

test('连续写两次印象：at 始终不动', () => {
  withTempCards(() => {
    const fixedAt = 1_500_000_000_000
    saveWill({ at: fixedAt, talk: false, talkReason: '', watch: false, watchReason: '', impressions: {} })
    setImpression(`${UID}-a`, '第一次')
    setImpression(`${UID}-b`, '第二次')
    const w = loadWill()
    assert.equal(w.at, fixedAt)
    assert.equal(Object.keys(w.impressions).length, 2)
  })
})
