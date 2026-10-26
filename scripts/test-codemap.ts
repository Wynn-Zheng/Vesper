/**
 * 代码地图的体检。
 *
 * 它现在有一份缓存的"我长什么样"，进 prompt 时用精简版，
 * 只在代码改过之后重建（或者用户说"重新扫一遍"）。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

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

const cm = await import('../src/self/codemap.ts')
const FILE = 'persona/codemap.md'

/* ---------- 1. 扫描 ---------- */
console.log('=== 1. 扫描结构 ===')
{
  const mods = cm.scanModules()
  check(`扫出 ${mods.length} 块`, mods.length >= 10, String(mods.length))

  const names = mods.map((m) => m.dir)
  for (const must of ['loop', 'memory', 'self', 'core', 'relation']) {
    check(`包含 ${must}/`, names.includes(must), names.join(','))
  }

  // 每块都得有说明（不能是"还没写说明"）
  const noDesc = mods.filter((m) => m.desc.includes('还没写说明'))
  check('每块都有说明', noDesc.length === 0, noDesc.map((m) => m.dir).join(','))

  // 行数 / 文件数都是正数
  const bad = mods.filter((m) => m.files <= 0 || m.lines <= 0)
  check('文件数行数都是正数', bad.length === 0, bad.map((m) => m.dir).join(','))

  const totalFiles = mods.reduce((a, m) => a + m.files, 0)
  check(`总文件数 ${totalFiles} 合理（>30）`, totalFiles > 30, String(totalFiles))
}

/* ---------- 2. 渲染 ---------- */
console.log('\n=== 2. 渲染 ===')
{
  const mods = cm.scanModules()

  const brief = cm.renderCodeMapBrief(mods)
  check('精简版非空', brief.length > 100, String(brief.length))
  check('精简版带块数', /分 \d+ 块/.test(brief), brief.split('\n')[0])
  check('精简版每块一行', brief.split('\n').length >= mods.length, `${brief.split('\n').length} 行`)
  check('精简版不超过 2000 字（不能吃光 prompt）', brief.length < 2000, String(brief.length))

  const full = cm.renderCodeMap(mods)
  check('完整版有表格', full.includes('| 模块 |'), full.slice(0, 100))
  check('完整版有消息链路', full.includes('一条消息进来之后怎么走'), '')
  check('完整版比精简版长', full.length > brief.length * 2, `${full.length} vs ${brief.length}`)
}

/* ---------- 3. 缓存与过期 ---------- */
console.log('\n=== 3. 缓存 ===')
{
  const had = existsSync(FILE)
  const backup = had ? readFileSync(FILE, 'utf8') : ''

  // 3a. 没有缓存时算过期
  if (had) unlinkSync(FILE)
  check('没有缓存时算过期', cm.isCodeMapStale() === true)

  // 3b. 建一次之后不算过期
  const r = cm.refreshCodeMap(true)
  check('强制刷新会重建', r.rebuilt === true)
  check('刷新后模块数对', r.modules === cm.scanModules().length, String(r.modules))
  check('文件写出来了', existsSync(FILE))

  // 3c. 刚建的不该过期
  check('刚建的不算过期', cm.isCodeMapStale() === false)

  // 3d. 不强制且没过期时不重建
  const r2 = cm.refreshCodeMap(false)
  check('不强制且没过期时不重建', r2.rebuilt === false, JSON.stringify(r2))

  // 3e. 把缓存 mtime 弄旧，应该算过期
  const old = Date.now() - 7 * 24 * 3600_000
  const { utimesSync } = await import('node:fs')
  utimesSync(FILE, new Date(old), new Date(old))
  check('缓存比源码旧时算过期', cm.isCodeMapStale() === true)

  // 恢复
  if (backup) writeFileSync(FILE, backup, 'utf8')
  else cm.refreshCodeMap(true)
}

/* ---------- 4. rescan_code 工具 ---------- */
console.log('\n=== 4. rescan_code 工具 ===')
{
  const tools = await import('../src/tools/code.ts')
  const t = tools.codeTools.find((x) => x.name === 'rescan_code')
  check('注册了 rescan_code', t !== undefined)

  if (t) {
    const out = await t.run({}, { personId: 'x', scope: 'private:x', now: new Date() })
    check('rescan_code 能跑', out.includes('扫完了'), out.slice(0, 60))
    check('返回了结构摘要', out.includes('分') && out.includes('块'), out.slice(0, 80))
  }
}

/* ---------- 5. 进 prompt ---------- */
console.log('\n=== 5. 进 prompt ===')
{
  const { buildSystem } = await import('../src/loop/prompt.ts')
  const { DEFAULTS } = await import('../src/core/config.ts')

  const sys = buildSystem({
    rules: DEFAULTS,
    now: new Date(),
    codeMap: cm.renderCodeMapBrief(cm.scanModules()),
  })
  check('prompt 里有"身体结构"', sys.includes('你自己的身体结构'), sys.slice(0, 60))
  check('prompt 里有模块清单', sys.includes('loop/') && sys.includes('memory/'), '')
  check('prompt 里没有反问示例', !sys.includes('想让我看哪段？\n'), '')
  check('prompt 总量没爆（<4000 字）', sys.length < 4000, String(sys.length))
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
