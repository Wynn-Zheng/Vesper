/**
 * 备份的导出 / 导入。
 *
 * 重点验证三件事：
 *   1. 导出的东西能完整导入回来（以前只有导出、没有导入）
 *   2. 默认是"合并"：重复导入幂等，不覆盖现有数据
 *   3. 关系能被导出（旧版用 JSON.parse 读 YAML，永远是 null）
 *
 * 全部在临时目录里跑；靠 chdir 让各模块的相对路径落在临时目录。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

const base = mkdtempSync(join(tmpdir(), 'qqbot-backup-'))
const A = join(base, 'a')
const B = join(base, 'b')
mkdirSync(A, { recursive: true })
mkdirSync(B, { recursive: true })
const originalCwd = process.cwd()

const { exportAll, importBackup, parseBackup, BACKUP_SCHEMA } = await import('../src/console/backup.ts')
const store = await import('../src/memory/store.ts')
const facts = await import('../src/memory/facts.ts')
const open = await import('../src/people/open.ts')
const people = await import('../src/people/store.ts')
const relation = await import('../src/relation/store.ts')
const profile = await import('../src/persona/profile.ts')
const session = await import('../src/loop/session.ts')
const { initLog } = await import('../src/core/log.ts')

initLog(join(base, 'logs'), false)

process.on('exit', () => {
  try {
    process.chdir(originalCwd)
  } catch {
    /* ignore */
  }
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/* ---------------- 1. 造数据 ---------------- */

console.log('=== 1. 造一份数据 ===')
process.chdir(A)

people.savePerson({
  id: 'qq-50001',
  name: '小明',
  accounts: [{ platform: 'qq', id: '50001' }],
  firstSeen: 1_700_000_000_000,
})
facts.appendFacts('qq-50001', [
  { text: '他在学吉他', date: '2026-10-01', confidence: 0.9, visibility: 'public', tier: 'normal' },
  { text: '他怕半途而废', date: '2026-10-02', confidence: 0.8, visibility: 'private', tier: 'normal' },
])
open.appendOpen('qq-50001', [{ text: '问问他吉他学得怎样', date: '2026-10-01', kind: 'todo' }])
relation.saveRelation('qq-50001', {
  closeness: 42,
  anchors: [{ date: '2026-10-01', event: '分享了私事', dimension: '信任', direction: 'up', amount: 2, reason: '愿意说自己的事' }],
  dimensions: { 信任: [{ date: '2026-10-01', event: '分享了私事', direction: 'up' }], 亲密: [], 好奇: [], 依赖: [] },
})
profile.saveProfile('qq-50001', '他挺安静的，但聊起来话不少。')
store.saveEpisode({
  id: '2026-10-01-01',
  date: '2026-10-01',
  scope: 'private:50001',
  importance: 7,
  emotion: '平静',
  title: '聊到吉他',
  body: '他说在学吉他，怕坚持不下来。',
})
store.appendInsights([{ id: '2026-10-01-1', date: '2026-10-01', scope: 'private:50001', text: '他其实很怕半途而废', evidence: [] }])
store.appendRaw({ ts: Date.now(), scope: 'private:50001', role: 'user', text: '我最近在学吉他' })
session.saveSession({
  key: 'private:50001',
  turns: [{ role: 'user', content: '我最近在学吉他', at: Date.now() }],
  summary: '聊了吉他，他怕坚持不下来。',
  summaryUpdatedAt: Date.now(),
  summaryCursor: 0,
})
mkdirSync('persona', { recursive: true })
writeFileSync('persona/self.md', '# 我\n\n我是个会认真听人说话的家伙。\n')
writeFileSync('persona/rules.yaml', '人格:\n  名字: 小满\n')

/* ---------------- 2. 导出 ---------------- */

console.log('\n=== 2. 导出 ===')
{
  const backup = exportAll(30)
  check('带 schema 版本', backup.schema === BACKUP_SCHEMA)
  check('导出人物', backup.people.length === 1)
  check('导出事实', backup.people[0]!.facts.length === 2)
  check('导出待办', backup.people[0]!.open.length === 1)
  check(
    '导出关系（旧版用 JSON.parse 读 YAML，这里永远是 null）',
    backup.people[0]!.relation?.closeness === 42,
    JSON.stringify(backup.people[0]!.relation),
  )
  check('导出画像', (backup.people[0]!.profile ?? '').includes('安静'))
  check('导出经历', backup.episodes.length === 1)
  check('导出洞察（旧版漏了）', backup.insights.length === 1)
  check('导出会话（旧版漏了）', backup.sessions.length === 1)
  check('导出原文', backup.raw.length >= 1)
  check('导出自述（人格文件）', (backup.files.self ?? '').includes('认真听'))
  check('导出规则（配置，默认不导回）', (backup.files.rules ?? '').includes('小满'))

  // 导入到另一个空目录
  process.chdir(B)
  store.invalidateEpisodes()
  people.clearPersonCache()
  session.clearSessions()

  console.log('\n=== 3. 导入到空环境 ===')
  const stats = importBackup(backup)
  check('导入人物', stats.people === 1, JSON.stringify(stats))
  check('导入事实', stats.facts === 2, JSON.stringify(stats))
  check('导入待办', stats.open === 1)
  check('导入经历', stats.episodes === 1)
  check('导入洞察', stats.insights === 1)
  check('导入会话', stats.sessions === 1)
  check('导入人格文件（self）', stats.files.includes('self'), stats.files.join(','))
  check('默认不导入 rules（怕冲掉手调配置）', !stats.files.includes('rules'), stats.files.join(','))
  check('导入前拍了快照', typeof stats.snapshot === 'string' && stats.snapshot.length > 0, String(stats.snapshot))

  check('磁盘上关系恢复', relation.loadRelation('qq-50001').closeness === 42)
  check('磁盘上事实恢复', facts.loadFacts('qq-50001').length === 2)
  check('磁盘上待办恢复', open.loadOpen('qq-50001').length === 1)
  check('磁盘上经历恢复', store.loadEpisodes().some((e) => e.title === '聊到吉他'))
  check('磁盘上洞察恢复', store.loadInsights().length === 1)
  check('磁盘上会话恢复', session.loadSession('private:50001').turns.length === 1)
  check('磁盘上自述恢复', readFileSync('persona/self.md', 'utf8').includes('认真听'))
  check('磁盘上没有 rules（默认跳过）', !readFileExists('persona/rules.yaml'))
  check('原文按 ts 落到今天', store.readRaw(todayKey()).length >= 1)

  /* ---------------- 4. 幂等 ---------------- */

  console.log('\n=== 4. 重复导入幂等 ===')
  const again = importBackup(backup)
  check('事实不重复', facts.loadFacts('qq-50001').length === 2, String(facts.loadFacts('qq-50001').length))
  check('经历不重复', store.loadEpisodes().filter((e) => e.title === '聊到吉他').length === 1)
  check('洞察不重复', store.loadInsights().length === 1, String(store.loadInsights().length))
  check('待办不重复', open.loadOpen('qq-50001').length === 1)
  check('统计里新增为 0', again.facts === 0 && again.episodes === 0, JSON.stringify(again))

  /* ---------------- 5. 覆盖模式 ---------------- */

  console.log('\n=== 5. overwrite 覆盖 ===')
  relation.saveRelation('qq-50001', { closeness: 3, anchors: [], dimensions: { 信任: [], 亲密: [], 好奇: [], 依赖: [] } })
  const ow = importBackup(backup, { overwrite: true })
  check('覆盖后关系回到备份值', relation.loadRelation('qq-50001').closeness === 42, String(relation.loadRelation('qq-50001').closeness))
  check('覆盖模式统计正常', ow.people === 1)

  /* ---------------- 6. includeConfig ---------------- */

  console.log('\n=== 6. 显式导入配置 ===')
  const cfg = importBackup(backup, { includeConfig: true })
  check('includeConfig 后导入 rules', cfg.files.includes('rules'), cfg.files.join(','))
  check('rules 内容写进去了', readFileExists('persona/rules.yaml') && readFileSync('persona/rules.yaml', 'utf8').includes('小满'))

  /* ---------------- 7. dryRun ---------------- */

  console.log('\n=== 7. dryRun 不落盘 ===')
  const beforeFacts = facts.loadFacts('qq-50001').length
  facts.deleteFact('qq-50001', '他在学吉他')
  const dry = importBackup(backup, { dryRun: true })
  check('dryRun 有统计', dry.facts >= 0)
  check('dryRun 没写盘（删掉的事实没被恢复）', facts.loadFacts('qq-50001').some((f) => f.text === '他在学吉他') === false, String(beforeFacts))

  /* ---------------- 8. 格式校验 ---------------- */

  console.log('\n=== 8. 格式校验 ===')
  check(
    '坏 JSON 报错',
    (() => {
      try {
        parseBackup('{')
        return false
      } catch {
        return true
      }
    })(),
  )
  check(
    '不是备份的文件报错',
    (() => {
      try {
        parseBackup('{"hello":1}')
        return false
      } catch {
        return true
      }
    })(),
  )
  check('旧版（无 schema）能认', parseBackup(JSON.stringify({ people: [], episodes: [] })).schema === 'qqbot-backup/1')
  check('v1 缺 sessions/insights 时当空', parseBackup(JSON.stringify({ people: [] })).sessions.length === 0)
}

function readFileExists(p: string): boolean {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
