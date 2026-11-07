/**
 * 打绿色版（免安装目录）。
 *
 * 为什么不用 electron-builder：
 *   它打包时要重新下载一份 Electron 二进制（不复用 node_modules/electron/dist），
 *   这台机器网络拉不动（app-builder.exe ERR_ELECTRON_BUILDER_CANNOT_EXECUTE）。
 *   而 electron/dist 本身就是一个可运行的 Electron 运行时 —— 复制过来、
 *   把 resources/default_app.asar 换成我们的 app/ 就行，**全程不需要网络**。
 *
 * 产物：
 *   release/Vesper/
 *   ├── Vesper.exe                 ← 从 electron.exe 改名
 *   ├── *.dll / *.pak / locales/  ← Electron 运行时
 *   └── resources/
 *       ├── app/                  ← 我们的代码（main.js + build/ + console/ + 依赖）
 *       └── persona-template/     ← 首次启动复制到用户数据目录
 *
 * 用法：node scripts/package-electron.ts
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const ROOT = resolve('.')
const ELECTRON_DIR = join(ROOT, 'electron')
const DIST_SRC = join(ELECTRON_DIR, 'node_modules', 'electron', 'dist')
const OUT = join(ROOT, 'release', 'Vesper')
const APP = join(OUT, 'resources', 'app')

function step(msg: string): void {
  console.log('\n▸ ' + msg)
}

function ok(msg: string): void {
  console.log('  ✓ ' + msg)
}

function fail(msg: string): never {
  console.error('  ✗ ' + msg)
  process.exit(1)
}

/** 目录大小（MB） */
function dirSizeMB(dir: string): number {
  let total = 0
  const walk = (p: string): void => {
    for (const entry of readdirSync(p, { withFileTypes: true })) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) walk(full)
      else total += statSync(full).size
    }
  }
  walk(dir)
  return total / (1024 * 1024)
}

async function main(): Promise<void> {
  console.log('打包 Vesper 绿色版')
  console.log('  项目：' + ROOT)
  console.log('  输出：' + OUT)

  /* ---------- 1. 编译 src/ → build/ ---------- */
  step('编译 src/ → build/（Electron 的 Node 20 跑不了 .ts）')
  if (existsSync(join(ROOT, 'build'))) rmSync(join(ROOT, 'build'), { recursive: true, force: true })
  try {
    execFileSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
  } catch {
    fail('编译失败')
  }
  if (!existsSync(join(ROOT, 'build', 'index.js'))) fail('build/index.js 没生成')
  ok('build/ 就绪')

  /* ---------- 2. 复制 Electron 运行时 ---------- */
  step('复制 Electron 运行时')
  if (!existsSync(DIST_SRC)) fail('找不到 ' + DIST_SRC + '（electron 没装？）')
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  cpSync(DIST_SRC, OUT, { recursive: true })
  ok('运行时已复制')

  /* ---------- 3. 换掉 default_app ---------- */
  step('替换 resources/default_app.asar')
  const defaultApp = join(OUT, 'resources', 'default_app.asar')
  if (existsSync(defaultApp)) {
    rmSync(defaultApp, { force: true })
    ok('已删除')
  } else {
    ok('本来就没有')
  }

  /* ---------- 4. 组装 resources/app ---------- */
  step('组装 resources/app')
  mkdirSync(APP, { recursive: true })

  // 主进程和 preload 用 .js（Electron 的 package.json `main` 只认 .js，写 .cjs 会静默不加载）。
  // 它们是 CJS，所以 app/package.json 不能有 type:module；
  // 而 build/ 里的后端是 ESM —— 靠 build/package.json 单独声明类型（Node 的目录级覆盖）。
  cpSync(join(ELECTRON_DIR, 'main.js'), join(APP, 'main.js'))
  if (existsSync(join(ELECTRON_DIR, 'preload.js'))) {
    cpSync(join(ELECTRON_DIR, 'preload.js'), join(APP, 'preload.js'))
  }
  cpSync(join(ROOT, 'build'), join(APP, 'build'), { recursive: true })
  cpSync(join(ROOT, 'console'), join(APP, 'console'), { recursive: true })
  // 示例插件要跟着发行包走：控制台「插件」页读的是这里的目录，
  // 少了它，装完打开插件页是空的 —— 用户会以为插件功能坏了。
  if (existsSync(join(ROOT, 'plugins'))) {
    cpSync(join(ROOT, 'plugins'), join(APP, 'plugins'), { recursive: true })
    ok('main.js / preload.js / build / console / plugins')
  } else {
    ok('main.js / preload.js / build / console（没有 plugins/，跳过）')
  }

// 版本信息：控制台「关于」显示构建时间，也用于更新比对
  const pkgForVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
  let gitForVersion = ''
  try {
    gitForVersion = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    /* 不是 git 仓库 */
  }
  writeFileSync(
    join(APP, 'version.json'),
    JSON.stringify({ version: pkgForVersion.version ?? '0.0.0', buildTime: new Date().toISOString(), git: gitForVersion }, null, 2) + '\n',
    'utf8',
  )
  ok('version.json')

  if (existsSync(join(ELECTRON_DIR, 'icon.png'))) {
    cpSync(join(ELECTRON_DIR, 'icon.png'), join(APP, 'icon.png'))
    ok('icon.png（窗口 + 托盘）')
  } else {
    console.log('  · 没有 icon.png，用 Electron 默认图标')
  }

  // build/ 下的 .js 是 ESM：用子目录 package.json 覆盖父级的 CommonJS 默认
  writeFileSync(join(APP, 'build', 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n', 'utf8')
  ok('build/package.json（type: module）')

  // 根的 package.json：不带 type（默认 CJS，main.js/preload.js 需要），main 指到 main.js
  writeFileSync(
    join(APP, 'package.json'),
    JSON.stringify(
      {
        name: 'vesper',
        private: true,
        main: 'main.js',
        version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
        dependencies: { ws: '^8.18.0', yaml: '^2.6.0' },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  ok('package.json（main → main.js，无 type）')

  // 只带运行时依赖的两个包（ws / yaml 都没有子依赖）
  const appMods = join(APP, 'node_modules')
  mkdirSync(appMods, { recursive: true })
  for (const dep of ['ws', 'yaml']) {
    const src = join(ROOT, 'node_modules', dep)
    if (!existsSync(src)) fail('node_modules/' + dep + ' 不存在')
    cpSync(src, join(appMods, dep), { recursive: true })
  }
  ok('node_modules/{ws,yaml}')

  // 源码也带上（约 2MB）：「读自己的代码」这个能力要读 .ts，
  // 只带 build/ 的话它读到的是编译后的 JS，跟仓库里的对不上。
  // core/paths.ts 的 srcRoot() 会优先找 QQBOT_ROOT/src。
  cpSync(join(ROOT, 'src'), join(APP, 'src'), { recursive: true })
  ok('src/（让「读自己的代码」有东西可读）')

  /* ---------- 5. persona 模板 ---------- */
  step('放 persona 模板（首次启动复制到用户数据目录）')
  const tpl = join(OUT, 'resources', 'persona-template')
  mkdirSync(tpl, { recursive: true })
  for (const f of ['rules.yaml', 'plugins.yaml']) {
    const src = join(ROOT, 'persona', f)
    if (existsSync(src)) {
      cpSync(src, join(tpl, f))
      ok('persona-template/' + f)
    } else {
      console.log('  · 跳过 ' + f + '（源文件没有）')
    }
  }
  // 附一张示例角色卡：新用户首启不至于面对空白页，直接能看到"一张卡长什么样"。
  // 用仓库里的模板，**不要**用本机 persona/cards/ 下的真实卡（那是用户自己的数据）。
  const tplCard = join(ROOT, 'scripts', 'templates', 'example.card.md')
  if (existsSync(tplCard)) {
    mkdirSync(join(tpl, 'cards'), { recursive: true })
    cpSync(tplCard, join(tpl, 'cards', 'example.md'))
    ok('persona-template/cards/example.md')
  }


  /* ---------- 6. 不打包 asar，保留裸目录 ---------- */
  step('保留 resources/app 裸目录（不打 asar）')
  // 这台机器上 Electron 加载 app.asar 会 0xC0000005 访问冲突崩溃，
  // 裸目录反而更稳（main.js 的 APP_ROOT 两种都支持）。
  ok('resources/app 已就位')

  /* ---------- 7. 改名 exe ---------- */
  step('把 electron.exe 改名成 Vesper.exe')
  const exeSrc = join(OUT, 'electron.exe')
  const exeDst = join(OUT, 'Vesper.exe')
  if (!existsSync(exeSrc)) fail('找不到 electron.exe')
  cpSync(exeSrc, exeDst)
  rmSync(exeSrc, { force: true })
  ok('Vesper.exe')

  /* ---------- 8. 更新包（给服务器用） ---------- */
  step('生成更新包 app.tar.gz + latest.json')
  const UPD = join(ROOT, 'dist-update')
  rmSync(UPD, { recursive: true, force: true })
  mkdirSync(UPD, { recursive: true })
  // 只打 resources/app（3 MB 左右）。exe、Electron 运行时、二维码等都不动。
  // NapCat 不再内置（曾内置 1.2 GB，把整个包撑到 1.4 GB）：
  // 用户首次启动时检测不到就引导去官方装，装完控制台能自动接上。
  execFileSync('tar', ['-czf', join(UPD, 'app.tar.gz'), '-C', join(OUT, 'resources'), 'app'], { stdio: 'inherit' })
  const gz = readFileSync(join(UPD, 'app.tar.gz'))
  const hash = createHash('sha256').update(gz).digest('hex')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
  let git = ''
  try {
    git = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    /* 不是 git 仓库就算了 */
  }
  const latest = {
    version: pkg.version ?? '0.0.0',
    buildTime: new Date().toISOString(),
    git,
    app: { url: 'app.tar.gz', sha256: hash, size: gz.length },
  }
  writeFileSync(join(UPD, 'latest.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8')
  ok('dist-update/app.tar.gz（' + (gz.length / 1024 / 1024).toFixed(2) + ' MB）')
  ok('dist-update/latest.json（版本 ' + latest.version + (git ? ' / ' + git : '') + '）')

  /* ---------- 9. 报告 ---------- */
  console.log('\n✅ 打好了')
  console.log('  目录：' + OUT)
  console.log('  大小：' + dirSizeMB(OUT).toFixed(1) + ' MB')
  console.log('')
  console.log('  双击 release\\Vesper\\Vesper.exe 启动。')
  console.log('  首次运行会在 %APPDATA%\\Vesper\\data-root 生成 .env（随机 token + 空 API Key）。')
  console.log('  打开控制台后在「设置 → 模型」里填 DeepSeek API Key。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
