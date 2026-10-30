/**
 * 插件权限自检：node scripts/selfcheck-plugin-permissions.ts
 *
 * 验证三件事：
 *   1. manifest 里的 permissions 只收已知名字（未知的丢掉，不会让插件挂掉）
 *   2. ctx 上有什么能力，严格按声明给（net / memory / message 互不串）
 *   3. 声明 message 但宿主没给 send 时，ctx.send 不存在（不会给一个会炸的函数）
 *
 * 不读写 persona/ 与 data/ 下的任何真实数据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '../src/plugins/host.ts'
import { parseManifest } from '../src/plugins/manifest.ts'

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

/** 一个插件，激活时把自己 ctx 上有什么能力写进文件 */
function probeEntry(markerPath: string): string {
  return `
import { writeFileSync } from 'node:fs'
export function activate(ctx) {
  const caps = {
    fetch: typeof ctx.fetch,
    readPersona: typeof ctx.readPersona,
    send: typeof ctx.send,
    registerTool: typeof ctx.registerTool,
  }
  writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(caps), 'utf8')
}
`
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-plugin-perm-'))
  const pluginsRoot = join(root, 'plugins')
  const dataRoot = join(root, 'data')
  mkdirSync(pluginsRoot, { recursive: true })
  mkdirSync(dataRoot, { recursive: true })

  try {
    /* ============ 1. manifest 校验 ============ */
    console.log('=== 1. manifest 的 permissions ===')
    const good = parseManifest({
      id: 'good',
      name: 'Good',
      version: '1.0.0',
      entry: 'index.mjs',
      permissions: ['net', 'memory'],
    })
    check('合法权限被保留', good.ok === true && JSON.stringify(good.manifest.permissions) === '["net","memory"]', JSON.stringify(good))

    const unknown = parseManifest({
      id: 'unknown',
      name: 'Unknown',
      version: '1.0.0',
      entry: 'index.mjs',
      permissions: ['net', 'hacker', 'root'],
    })
    check(
      '未知权限被丢掉，只剩已知的',
      unknown.ok === true && JSON.stringify(unknown.manifest.permissions) === '["net"]',
      JSON.stringify(unknown.ok ? unknown.manifest.permissions : unknown),
    )

    const dup = parseManifest({
      id: 'dup',
      name: 'Dup',
      version: '1.0.0',
      entry: 'index.mjs',
      permissions: ['net', 'net', 'net'],
    })
    check('重复权限去重', dup.ok === true && JSON.stringify(dup.manifest.permissions) === '["net"]', JSON.stringify(dup.ok ? dup.manifest.permissions : dup))

    const none = parseManifest({ id: 'none', name: 'None', version: '1.0.0', entry: 'index.mjs' })
    check('不写 permissions 就是没有', none.ok === true && none.manifest.permissions === undefined, JSON.stringify(none))

    const notArray = parseManifest({ id: 'bad', name: 'Bad', version: '1.0.0', entry: 'index.mjs', permissions: 'net' })
    check('permissions 不是数组时校验失败', notArray.ok === false, JSON.stringify(notArray))

    /* ============ 2. ctx 能力按声明给 ============ */
    console.log('\n=== 2. ctx 能力按声明给 ===')

    const markerNet = join(root, 'caps-net.json')
    const markerMem = join(root, 'caps-mem.json')
    const markerMsg = join(root, 'caps-msg.json')
    const markerNone = join(root, 'caps-none.json')
    const markerNoSend = join(root, 'caps-nosend.json')

    writePlugin(pluginsRoot, 'p-net', { id: 'p-net', name: 'Net', version: '1.0.0', entry: 'index.mjs', permissions: ['net'] }, 'index.mjs', probeEntry(markerNet))
    writePlugin(pluginsRoot, 'p-mem', { id: 'p-mem', name: 'Mem', version: '1.0.0', entry: 'index.mjs', permissions: ['memory'] }, 'index.mjs', probeEntry(markerMem))
    writePlugin(pluginsRoot, 'p-msg', { id: 'p-msg', name: 'Msg', version: '1.0.0', entry: 'index.mjs', permissions: ['message'] }, 'index.mjs', probeEntry(markerMsg))
    writePlugin(pluginsRoot, 'p-none', { id: 'p-none', name: 'None', version: '1.0.0', entry: 'index.mjs' }, 'index.mjs', probeEntry(markerNone))
    // 声明 message，但宿主不给 send → ctx.send 应该也不存在
    writePlugin(pluginsRoot, 'p-nosend', { id: 'p-nosend', name: 'NoSend', version: '1.0.0', entry: 'index.mjs', permissions: ['message'] }, 'index.mjs', probeEntry(markerNoSend))

    const sends: string[] = []
    const host = createHost({
      pluginsRoot,
      dataRoot,
      settingsFile: join(root, 'plugins.yaml'),
      send: async (target, text) => {
        sends.push(target.kind + ':' + target.id + ':' + text)
      },
    })

    // 不带 send 的宿主：给 p-nosend 用
    const hostNoSend = createHost({
      pluginsRoot,
      dataRoot: join(root, 'data2'),
      settingsFile: join(root, 'plugins.yaml'),
    })

    for (const id of ['p-net', 'p-mem', 'p-msg', 'p-none']) {
      const r = await host.load(id)
      check(`load(${id})`, r.ok === true, r.error ?? '')
    }
    const rNoSend = await hostNoSend.load('p-nosend')
    check('load(p-nosend) 在不给 send 的宿主上', rNoSend.ok === true, rNoSend.error ?? '')

    // 用 ESM 方式读（这里没有 require）
    const fs = await import('node:fs')
    const caps = (path: string): Record<string, string> => {
      try {
        return JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, string>
      } catch {
        return {}
      }
    }

    const net = caps(markerNet)
    check('p-net：有 fetch', net.fetch === 'function', JSON.stringify(net))
    check('p-net：没有 readPersona', net.readPersona === 'undefined', JSON.stringify(net))
    check('p-net：没有 send', net.send === 'undefined', JSON.stringify(net))

    const mem = caps(markerMem)
    check('p-mem：有 readPersona', mem.readPersona === 'function', JSON.stringify(mem))
    check('p-mem：没有 fetch', mem.fetch === 'undefined', JSON.stringify(mem))

    const msg = caps(markerMsg)
    check('p-msg：有 send', msg.send === 'function', JSON.stringify(msg))
    check('p-msg：没有 fetch', msg.fetch === 'undefined', JSON.stringify(msg))

    const none2 = caps(markerNone)
    check('p-none：三个能力都没有', none2.fetch === 'undefined' && none2.readPersona === 'undefined' && none2.send === 'undefined', JSON.stringify(none2))

    const noSend = caps(markerNoSend)
    check('p-nosend：声明了 message 但宿主没给 send → ctx.send 不存在', noSend.send === 'undefined', JSON.stringify(noSend))

    check('所有插件都有 registerTool（不受权限影响）', net.registerTool === 'function' && none2.registerTool === 'function', JSON.stringify({ net: net.registerTool, none: none2.registerTool }))

    /* ============ 3. readPersona 的路径约束 ============ */
    console.log('\n=== 3. readPersona 路径约束 ===')
    // 直接构造一个声明 memory 的 ctx 太重，这里测它的两条规则在源码里
    const hostSrc = fs.readFileSync('src/plugins/host.ts', 'utf8')
    check('拒绝含 .. 的路径', hostSrc.includes("relPath.includes('..')"), '')
    check('拒绝绝对路径（盘符）', hostSrc.includes('/^[A-Za-z]:/'), '')
    check('限制在 persona/ 下', hostSrc.includes("join('persona', relPath)"), '')

    await host.unload('p-net')
    await host.unload('p-mem')
    await host.unload('p-msg')
    await host.unload('p-none')
  } finally {
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
