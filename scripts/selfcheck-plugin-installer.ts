/**
 * 插件安装器自检：node scripts/selfcheck-plugin-installer.ts
 * 在系统临时目录里造一个插件源目录，验证安装、禁用、更新检查与卸载。
 * 不读写真实 plugins/、persona/、data/ 下的任何数据。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkUpdates, installPlugin, setEnabled, uninstallPlugin } from '../src/plugins/installer.ts'
import { scanPlugins } from '../src/plugins/registry.ts'

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

/** 造一个合法的插件源目录，写入 plugin.json 和入口文件 */
function writePluginSource(root: string, dirName: string, manifest: unknown): string {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  writeFileSync(join(dir, 'index.js'), 'export function activate() {}\n', 'utf8')
  return dir
}

/** 读取 JSON 文件；读不到或解析失败返回 undefined */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-plugin-installer-'))

  try {
    const pluginsRoot = join(root, 'plugins')
    const sourceRoot = join(root, 'sources')
    const source = writePluginSource(sourceRoot, 'demo-src', {
      id: 'demo',
      name: '演示插件',
      version: '1.0.0',
      entry: 'index.js',
      description: '用于自检的本地插件',
    })
    const targetDir = join(pluginsRoot, 'demo')

    /* ============ 1. 安装 ============ */
    console.log('=== 1. installPlugin ===')
    const first = await installPlugin({ source, pluginsRoot })
    check('首次安装成功', first.ok === true && first.id === 'demo', JSON.stringify(first))
    check('目标插件目录存在', existsSync(targetDir), targetDir)

    const recordPath = join(targetDir, '.install.json')
    check('.install.json 存在', existsSync(recordPath), recordPath)
    const record = readJson(recordPath)
    const recordObject =
      record !== null && typeof record === 'object' && !Array.isArray(record)
        ? (record as Record<string, unknown>)
        : undefined
    check('安装记录 version 为 1.0.0', recordObject?.['version'] === '1.0.0', String(recordObject?.['version']))
    check(
      '安装记录 source 是绝对路径',
      typeof recordObject?.['source'] === 'string' && recordObject['source'] === source,
      String(recordObject?.['source']),
    )
    check('入口文件已复制', existsSync(join(targetDir, 'index.js')))

    // 重复安装应当被拒绝
    const second = await installPlugin({ source, pluginsRoot })
    check('重复安装返回 ok=false', second.ok === false, JSON.stringify(second))
    check('重复安装错误为 already installed', second.error === 'already installed', String(second.error))

    /* ============ 2. 禁用 ============ */
    console.log('\n=== 2. setEnabled ===')
    const disabled = await setEnabled({ id: 'demo', pluginsRoot, enabled: false })
    check('禁用操作成功', disabled.ok === true, JSON.stringify(disabled))
    check('disabled 标记文件存在', existsSync(join(targetDir, 'disabled')))

    const scanAfterDisable = await scanPlugins(pluginsRoot)
    const demoPlugin = scanAfterDisable.plugins.find((plugin) => plugin.manifest.id === 'demo')
    check('scanPlugins 显示插件已禁用', demoPlugin?.enabled === false, String(demoPlugin?.enabled))

    /* ============ 3. 更新检查 ============ */
    console.log('\n=== 3. checkUpdates ===')
    const indexFile = join(pluginsRoot, 'index.json')
    writeFileSync(
      indexFile,
      JSON.stringify({ plugins: [{ id: 'demo', version: '2.0.0', description: '新版本' }] }, null, 2),
      'utf8',
    )

    const updates = await checkUpdates({ pluginsRoot })
    const demoUpdate = updates.items.find((item) => item.id === 'demo')
    check('索引版本更高时 hasUpdate 为 true', demoUpdate?.hasUpdate === true, JSON.stringify(demoUpdate))
    check('current 为 1.0.0', demoUpdate?.current === '1.0.0', String(demoUpdate?.current))
    check('latest 为 2.0.0', demoUpdate?.latest === '2.0.0', String(demoUpdate?.latest))

    // 删除索引后，函数本身不应抛错，每个插件都应带 error 且 hasUpdate=false
    rmSync(indexFile)
    let threw = false
    let missingIndex: Awaited<ReturnType<typeof checkUpdates>> | undefined
    try {
      missingIndex = await checkUpdates({ pluginsRoot })
    } catch {
      threw = true
    }
    const missingItem = missingIndex?.items.find((item) => item.id === 'demo')
    check('索引缺失时 checkUpdates 不抛错', threw === false)
    check('索引缺失时 hasUpdate 为 false', missingItem?.hasUpdate === false, JSON.stringify(missingItem))
    check(
      '索引缺失时该条目带 error',
      typeof missingItem?.error === 'string' && missingItem.error.length > 0,
      String(missingItem?.error),
    )

    /* ============ 4. 卸载 ============ */
    console.log('\n=== 4. uninstallPlugin ===')
    const removed = await uninstallPlugin({ id: 'demo', pluginsRoot })
    check('卸载成功', removed.ok === true, JSON.stringify(removed))
    check('卸载后目录消失', !existsSync(targetDir), targetDir)

    /* ============ 5. 异常输入 ============ */
    console.log('\n=== 5. 异常输入 ===')
    const missingSource = await installPlugin({
      source: join(root, 'not-exist'),
      pluginsRoot,
    })
    check('不存在的 source 返回 ok=false', missingSource.ok === false, JSON.stringify(missingSource))
    check(
      '错误信息包含“不存在”',
      typeof missingSource.error === 'string' && missingSource.error.includes('不存在'),
      String(missingSource.error),
    )

    const zipSource = join(root, 'fake.zip')
    writeFileSync(zipSource, 'PK', 'utf8')
    const zipInstall = await installPlugin({ source: zipSource, pluginsRoot })
    check('.zip source 返回 ok=false', zipInstall.ok === false, JSON.stringify(zipInstall))
    check(
      '错误信息说明不支持压缩包',
      typeof zipInstall.error === 'string' && zipInstall.error.includes('不支持'),
      String(zipInstall.error),
    )
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
