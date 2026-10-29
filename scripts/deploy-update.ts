/**
 * 发布更新包到服务器。
 *
 * 用法：
 *   node scripts/deploy-update.ts            打包 + 上传 + 校验
 *   node scripts/deploy-update.ts --no-build  用现有的 dist-update（不重新打包）
 *
 * 做的事：
 *   1. 跑 package-electron.ts（会升版本号检查、生成 dist-update/app.tar.gz + latest.json）
 *   2. 版本号没变就拒绝（否则服务器上还是旧版本，客户端点了"更新"却没变化）
 *   3. 服务器上旧的 app.tar.gz 改名成 app.prev.tar.gz（能回滚）
 *   4. 用 scp 传两个文件
 *   5. 带 token 拉回 latest.json，核对版本号 + sha256
 *
 * 需要：%USERPROFILE%\.ssh\qqbot_deploy（密钥）+ 服务器的 authorized_keys 里装好公钥。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST = process.env['DEPLOY_HOST'] ?? '8.134.34.215'
const PORT = process.env['DEPLOY_PORT'] ?? '22'
const USER = process.env['DEPLOY_USER'] ?? 'root'
const REMOTE_DIR = process.env['DEPLOY_PATH'] ?? '/www/wwwroot/web.wynnzheng.icu/QQbot'
const KEY = join(homedir(), '.ssh', 'qqbot_deploy')

/** 从 .env 读更新配置（脚本直接跑时 process.env 里没有） */
function envFromFile(name: string): string {
  if (process.env[name]) return process.env[name] as string
  try {
    const text = readFileSync(join(process.cwd(), '.env'), 'utf8')
    const m = new RegExp('^' + name + '=(.*)$', 'm').exec(text)
    return (m?.[1] ?? '').trim()
  } catch {
    return ''
  }
}

const UPD = join(process.cwd(), 'dist-update')
const TAR = join(UPD, 'app.tar.gz')
const JSON_FILE = join(UPD, 'latest.json')

function run(cmd: string, args: string[], opts: { capture?: boolean } = {}): string {
  const out = execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  return typeof out === 'string' ? out : ''
}

function fail(msg: string): never {
  console.error('\n❌ ' + msg)
  process.exit(1)
}

function step(msg: string): void {
  console.log('\n▸ ' + msg)
}

async function main(): Promise<void> {
  if (!existsSync(KEY)) fail('找不到密钥：' + KEY + '（先按说明生成并装到服务器）')

  const noBuild = process.argv.includes('--no-build')
  if (noBuild) {
    if (!existsSync(TAR) || !existsSync(JSON_FILE)) fail('dist-update 里没有现成的包，去掉 --no-build 重新打包')
  } else {
    step('打包（含生成 dist-update）')
    run('node', ['scripts/package-electron.ts'])
  }

  // 读本地包信息
  const local = JSON.parse(readFileSync(JSON_FILE, 'utf8')) as {
    version: string
    buildTime: string
    git?: string
    app: { url: string; sha256: string; size: number }
  }
  const localSha = createHash('sha256').update(readFileSync(TAR)).digest('hex')
  if (localSha !== local.app.sha256) fail('本地 latest.json 的 sha256 和 app.tar.gz 不一致（打包有问题）')
  console.log(`\n本地：${local.version}${local.git ? ' / ' + local.git : ''}  ${(local.app.size / 1024).toFixed(0)} KB`)

  // 检查服务器上当前是什么版本（用 token 拉 latest.json）
  step('检查服务器上的当前版本')
  let remoteVersion = ''
  try {
    const remoteJson = execFileSync(
      'curl',
      ['-sS', '-m', '20', '-H', `x-update-token: ${envFromFile('UPDATE_TOKEN')}`, `${envFromFile('UPDATE_URL')}/latest.json`],
      { encoding: 'utf8' },
    )
    remoteVersion = (JSON.parse(remoteJson) as { version?: string }).version ?? ''
  } catch {
    console.log('  （读不到服务器版本，可能是第一次发布）')
  }
  if (remoteVersion) console.log('服务器当前：' + remoteVersion)
  if (remoteVersion === local.version) {
    fail(
      `版本号没变（${local.version}），服务器上已经是这个版本。\n` +
        '   先改 package.json 的 version（比如 0.1.3）再发布。',
    )
  }

  // 旧包留一份可以回滚
  step('备份服务器上的旧包')
  run('ssh', [
    '-p', PORT, '-i', KEY, '-o', 'StrictHostKeyChecking=no', `${USER}@${HOST}`,
    `cd ${REMOTE_DIR} && [ -f app.tar.gz ] && cp -f app.tar.gz app.prev.tar.gz || true; echo done`,
  ])

  // 上传
  step('上传 app.tar.gz + latest.json')
  run('scp', [
    '-P', PORT, '-i', KEY, '-o', 'StrictHostKeyChecking=no',
    TAR, JSON_FILE, `${USER}@${HOST}:${REMOTE_DIR}/`,
  ])

  // 核对
  step('核对服务器上的结果')
  const remoteJson = execFileSync(
    'curl',
    ['-sS', '-m', '20', '-H', `x-update-token: ${envFromFile('UPDATE_TOKEN')}`, `${envFromFile('UPDATE_URL')}/latest.json`],
    { encoding: 'utf8' },
  )
  const after = JSON.parse(remoteJson) as { version: string; app: { sha256: string; size: number } }
  if (after.version !== local.version) fail(`服务器版本不对：${after.version}（本地 ${local.version}）`)
  if (after.app.sha256 !== localSha) fail('服务器上的包 sha256 和本地不一致（上传损坏）')
  console.log(`  ✓ 服务器版本 ${after.version}，sha256 一致`)

  // 顺便下一下包确认能下载（只取头，不落盘）
  step('确认更新包能下载')
  try {
    // Windows 没有 /dev/null，用 NUL；顺带比对字节数
    const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const head = execFileSync(
      'curl',
      [
        '-sS', '-o', nullDev, '-w', '%{http_code} %{size_download}',
        '-H', `x-update-token: ${envFromFile('UPDATE_TOKEN')}`,
        `${envFromFile('UPDATE_URL')}/app.tar.gz`,
      ],
      { encoding: 'utf8' },
    )
    console.log('  HTTP + 下载字节：' + head)
  } catch (e) {
    console.log('  （下载检查失败，不影响发布：' + String(e).slice(0, 100) + '）')
  }
  console.log('\n✅ 发布完成')
  console.log(`  版本：${local.version}${local.git ? ' / ' + local.git : ''}`)
  console.log(`  地址：${envFromFile('UPDATE_URL')}`)
  console.log('\n  那台机器上打开 设置 → 关于 → 更新 → 检查更新 就能看到新版本。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
