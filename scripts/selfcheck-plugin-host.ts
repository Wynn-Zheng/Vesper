/**
 * 插件宿主自检：node scripts/selfcheck-plugin-host.ts
 * 在系统临时目录里造两个假插件，验证插件的载入、卸载、重载与错误隔离。
 * 不读写 persona/ 与 data/ 下的任何真实数据。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '../src/plugins/host.ts'

const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`✓ ${name}`)
    return
  }
  const line = detail ? `${name}（${detail}）` : name
  failures.push(line)
  console.log(`✗ ${line}`)
}

/** 造一个插件目录：写入 plugin.json 和入口文件 */
function writePlugin(
  root: string,
  dirName: string,
  manifest: unknown,
  entryFile: string,
  source: string,
): string {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(dir, entryFile), source, 'utf8')
  return dir
}

const pluginASource = `
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

let markerPath = ''

export function activate(ctx) {
  // 确认 ctx 没有把 Node 全局暴露给插件
  if ('process' in ctx || 'require' in ctx) throw new Error('ctx 暴露了 Node 全局')

  markerPath = join(ctx.dataDir, 'marker.txt')
  writeFileSync(markerPath, 'active', 'utf8')
  ctx.log('A 已激活')
}

export function deactivate() {
  appendFileSync(markerPath, 'bye', 'utf8')
}
`

const pluginBSource = `
export function activate() {
  throw new Error('B 故意失败')
}
`

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-plugin-host-'))
  const pluginsRoot = join(root, 'plugins')
  const dataRoot = join(root, 'data')
  const aId = 'plugin-a'
  const bId = 'plugin-b'
  const aDataDir = join(dataRoot, 'plugins', aId)

  try {
    writePlugin(
      pluginsRoot,
      'a',
      { id: aId, name: '正常插件', version: '1.0.0', entry: 'index.mjs' },
      'index.mjs',
      pluginASource,
    )
    writePlugin(
      pluginsRoot,
      'b',
      { id: bId, name: '会失败的插件', version: '2.0.0', entry: 'index.mjs' },
      'index.mjs',
      pluginBSource,
    )

    const logs: string[] = []
    const host = createHost({
      pluginsRoot,
      dataRoot,
      logger: (level, message) => {
        logs.push(`${level}:${message}`)
      },
    })

    /* ============ 1. 正常载入 ============ */
    console.log('=== 1. load(A) ===')
    const loadA = await host.load(aId)
    check('A 加载成功', loadA.ok === true, loadA.error ?? '')
    check('A 的 dataDir 被真实创建', existsSync(aDataDir) && statSync(aDataDir).isDirectory(), aDataDir)

    const markerPath = join(aDataDir, 'marker.txt')
    check('A 的 activate 写入了证明文件', existsSync(markerPath) && readFileSync(markerPath, 'utf8') === 'active')
    check('A 调用了 ctx.log', logs.some((line) => line === 'info:A 已激活'))

    /* ============ 2. 失败被隔离 ============ */
    console.log('\n=== 2. load(B) 失败 ===')
    const loadB = await host.load(bId)
    check('B 加载返回失败但不抛异常', loadB.ok === false, String(loadB.ok))
    check('B 的错误进入 host.errors', host.errors.some((item) => item.id === bId && item.message.includes('B 故意失败')))

    /* ============ 3. 失败后宿主仍可用 ============ */
    console.log('\n=== 3. B 失败后继续 load/unload ===')
    const unloadAfterB = await host.unload(aId)
    check('B 失败后仍可 unload(A)', unloadAfterB.ok === true, unloadAfterB.error ?? '')
    const reloadAfterB = await host.load(aId)
    check('B 失败后仍可重新 load(A)', reloadAfterB.ok === true, reloadAfterB.error ?? '')

    /* ============ 4. 卸载副作用 ============ */
    console.log('\n=== 4. unload(A) ===')
    const unloadA = await host.unload(aId)
    check('unload(A) 成功', unloadA.ok === true, unloadA.error ?? '')
    check(
      "unload(A) 后 deactivate 写入的副作用文件含 'bye'",
      existsSync(markerPath) && readFileSync(markerPath, 'utf8').includes('bye'),
    )
    check('未加载的 id 再次 unload 返回 not loaded', (await host.unload(aId)).error === 'not loaded')

    /* ============ 5. 重载 ============ */
    console.log('\n=== 5. reload(A) ===')
    const reloadA = await host.reload(aId)
    check('reload(A) 成功', reloadA.ok === true, reloadA.error ?? '')
    const listed = host.list().find((item) => item.id === aId)
    check('reload(A) 后 list 中 loaded 为 true', listed?.loaded === true, JSON.stringify(listed))
    check('list 中的版本号来自清单', listed?.version === '1.0.0', listed?.version ?? '未找到')
    check('重载后 dataDir 仍然真实存在', existsSync(aDataDir) && statSync(aDataDir).isDirectory(), aDataDir)
  } finally {
    // 无论成功失败都清理临时目录
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(
  () => {
    if (failures.length > 0) {
      console.log(`\n${failures.length} 项未通过：`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exit(1)
    }
    console.log('\n全部通过')
    process.exit(0)
  },
  (err: unknown) => {
    console.log(`\n自检执行出错：${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    process.exit(1)
  },
)
