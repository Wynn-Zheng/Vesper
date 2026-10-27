/**
 * 插件注册表自检：node scripts/selfcheck-plugin-registry.ts
 * 在系统临时目录里造几个假插件，验证 parseManifest / scanPlugins / compareVersions。
 * 不读写 persona/ 与 data/ 下的任何真实数据。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, parseManifest } from '../src/plugins/manifest.ts'
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

/** 造一个插件目录，写入 plugin.json 并返回目录路径 */
function writePlugin(root: string, dirName: string, manifest: unknown): string {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

function expectThrows(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-plugin-registry-'))

  try {
    // 四个子目录：合法、版本非法、没有清单、合法但带 disabled 标记
    writePlugin(root, 'a-valid', { id: 'alpha', name: '合法插件', version: '1.2.3', entry: 'index.js' })
    writePlugin(root, 'b-bad-version', { id: 'bad-version', name: '版本不对', version: '1.0', entry: 'index.js' })
    mkdirSync(join(root, 'c-no-manifest'), { recursive: true })
    const disabledDir = writePlugin(root, 'd-disabled', {
      id: 'zeta',
      name: '被禁用',
      version: '2.0.0',
      entry: 'dist/main.mjs',
    })
    writeFileSync(join(disabledDir, 'disabled'), '', 'utf8')

    /* ============ 1. 扫描结果 ============ */
    console.log('=== 1. scanPlugins ===')
    const { plugins, errors } = await scanPlugins(root)

    check('扫描到 2 个可用插件', plugins.length === 2, `实际 ${plugins.length}`)
    check(
      '插件 id 按升序为 alpha,zeta',
      plugins.map((p) => p.manifest.id).join(',') === 'alpha,zeta',
      plugins.map((p) => p.manifest.id).join(','),
    )
    check('出错目录记录 2 条', errors.length === 2, `实际 ${errors.length}`)
    check(
      '出错目录已记录（b-bad-version、c-no-manifest）',
      errors.map((e) => e.id).sort().join(',') === 'b-bad-version,c-no-manifest',
      errors.map((e) => e.id).join(','),
    )

    const alpha = plugins.find((p) => p.manifest.id === 'alpha')
    const zeta = plugins.find((p) => p.manifest.id === 'zeta')
    check('alpha 的 dir 是绝对路径', !!alpha && alpha.dir === join(root, 'a-valid'), alpha?.dir ?? '未找到')
    check('alpha 默认启用', alpha?.enabled === true, String(alpha?.enabled))
    check('zeta 因 disabled 标记被禁用', zeta?.enabled === false, String(zeta?.enabled))

    // 根目录不存在属于正常情况
    const missing = await scanPlugins(join(root, 'not-exist'))
    check('根目录不存在时返回空结果', missing.plugins.length === 0 && missing.errors.length === 0)

    /* ============ 2. parseManifest ============ */
    console.log('\n=== 2. parseManifest ===')
    const good = parseManifest({
      id: 'demo-plugin',
      name: '演示',
      version: '0.1.0',
      entry: 'index.cjs',
      permissions: ['net'],
    })
    check('接受合法清单', good.ok === true, good.ok ? '' : good.errors.join('; '))
    check(
      "拒绝大写 id",
      parseManifest({ id: 'Demo', name: 'D', version: '1.0.0', entry: 'index.js' }).ok === false,
    )
    check(
      "拒绝含 '..' 的 entry",
      parseManifest({ id: 'demo', name: 'D', version: '1.0.0', entry: '../evil.js' }).ok === false,
    )
    check(
      '缺字段逐条报错且不抛异常',
      (() => {
        const r = parseManifest({})
        return r.ok === false && r.errors.length === 4
      })(),
    )
    check('非对象输入不抛异常', parseManifest(null).ok === false)

    /* ============ 2b. configSchema 校验 ============ */
    console.log('\n=== 2b. configSchema ===')
    const withSchema = parseManifest({
      id: 'demo',
      name: 'D',
      version: '1.0.0',
      entry: 'index.js',
      configSchema: {
        间隔: { type: 'number', default: 60, min: 1, max: 3600, label: '间隔（秒）' },
        通知: { type: 'boolean', default: true },
        模式: { type: 'select', options: ['宽松', '严格'], default: '宽松' },
      },
    })
    check('接受合法 configSchema', withSchema.ok === true, withSchema.ok ? '' : withSchema.errors.join('; '))
    check(
      'configSchema 被带进结果',
      withSchema.ok === true && withSchema.manifest.configSchema !== undefined,
    )
    check(
      '拒绝未知 type',
      parseManifest({
        id: 'demo',
        name: 'D',
        version: '1.0.0',
        entry: 'index.js',
        configSchema: { x: { type: 'color' } },
      }).ok === false,
    )
    check(
      'select 缺 options 被拒',
      parseManifest({
        id: 'demo',
        name: 'D',
        version: '1.0.0',
        entry: 'index.js',
        configSchema: { x: { type: 'select' } },
      }).ok === false,
    )
    check(
      'min 不是数字被拒',
      parseManifest({
        id: 'demo',
        name: 'D',
        version: '1.0.0',
        entry: 'index.js',
        configSchema: { x: { type: 'number', min: '1' } },
      }).ok === false,
    )
    check(
      '缺 type 被拒',
      parseManifest({
        id: 'demo',
        name: 'D',
        version: '1.0.0',
        entry: 'index.js',
        configSchema: { x: { default: 1 } },
      }).ok === false,
    )

    /* ============ 3. compareVersions ============ */
    console.log('\n=== 3. compareVersions ===')
    check("('1.2.3','1.2.10') === -1", compareVersions('1.2.3', '1.2.10') === -1)
    check("('2.0.0','1.9.9') === 1", compareVersions('2.0.0', '1.9.9') === 1)
    check("('1.2.3','1.2.3') === 0", compareVersions('1.2.3', '1.2.3') === 0)
    check("('10.0.0','9.9.9') === 1（按数字而不是字符串比较）", compareVersions('10.0.0', '9.9.9') === 1)
    check(
      "('1.2.3','1.2.3-beta') === 0（预发布后缀不参与）",
      compareVersions('1.2.3', '1.2.3-beta') === 0,
    )
    check("('1.0','1.0.0') 抛错", expectThrows(() => compareVersions('1.0', '1.0.0')))
    check("('x.y.z','1.0.0') 抛错", expectThrows(() => compareVersions('x.y.z', '1.0.0')))
  } finally {
    // 无论成功失败都清理临时目录
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(
  () => {
    if (failures.length > 0) {
      console.log(`\n${failures.length} 项未通过：`)
      for (const f of failures) console.log(`  - ${f}`)
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
