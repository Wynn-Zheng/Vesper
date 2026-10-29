/**
 * 把 NapCat 的 OneBot 连接配置自动指向我们的 bot。
 *
 * 为什么要这个：
 *   NapCat 的连接配置在 config/onebot11_<QQ号>.json 里，按账号分。
 *   扫码登录后 NapCat 会新建一个空配置（不连任何东西），
 *   用户得自己去 WebUI 里加一个 WebSocket 客户端 —— 这一步对不少人太难了。
 *
 * 什么时候跑：
 *   登录状态变成"已登录"的时候（那时候 config 里才有 onebot11_<QQ号>.json）。
 *
 * 安全边界：
 *   只动 websocketClients，而且是"没有指向我们时才加"；
 *   用户手动配过的不覆盖。
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** bot 的 OneBot WS 端口：跟着 ONEBOT_PORT 走（index.ts 里可改），不再写死 8765 */
const ONEBOT_PORT = (process.env.ONEBOT_PORT ?? '8765').trim() || '8765'

/** bot 的 OneBot WS 地址 */
const BOT_WS = `ws://127.0.0.1:${ONEBOT_PORT}/onebot/v11/ws`

/** 这条是不是"指向我们"的 */
function isOurs(client: Record<string, unknown>): boolean {
  const url = client['url']
  return typeof url === 'string' && url.includes(':' + ONEBOT_PORT + '/')
}

type OnebotFile = {
  path: string
  /** 改了吗 */
  changed: boolean
  /** 之前就有指向我们的配置 */
  already: boolean
}

/**
 * 扫描一个 NapCat 目录下所有 onebot11_*.json，缺我们的连接就补上。
 *
 * 返回改动情况；读不了/格式不对的文件跳过，不抛异常。
 */
export function wireOnebot(shellDir: string): { files: OnebotFile[]; error?: string } {
  const files: OnebotFile[] = []

  // NapCat 的配置固定在 <shell>/versions/<ver>/resources/app/napcat/config/
  const versionsDir = join(shellDir, 'versions')
  if (!existsSync(versionsDir)) return { files, error: `找不到 ${versionsDir}` }

  let verDirs: string[]
  try {
    verDirs = readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(versionsDir, e.name))
  } catch (e) {
    return { files, error: e instanceof Error ? e.message : String(e) }
  }

  for (const ver of verDirs) {
    const cfgDir = join(ver, 'resources', 'app', 'napcat', 'config')
    if (!existsSync(cfgDir)) continue

    let names: string[]
    try {
      names = readdirSync(cfgDir).filter((n) => /^onebot11_\d+\.json$/.test(n))
    } catch {
      continue
    }

    for (const name of names) {
      const path = join(cfgDir, name)
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const network = (raw['network'] ?? {}) as Record<string, unknown>
        const clients = Array.isArray(network['websocketClients'])
          ? (network['websocketClients'] as Record<string, unknown>[])
          : []

        if (clients.some(isOurs)) {
          files.push({ path, changed: false, already: true })
          continue
        }

        clients.push({
          enable: true,
          name: 'QQbot',
          url: BOT_WS,
          reportSelfMessage: false,
          messagePostFormat: 'array',
          // bot 默认不校验（ONEBOT_TOKEN 为空），而且只监听 127.0.0.1，本地连接不用 token
          token: '',
          debug: false,
          heartInterval: 5000,
          reconnectInterval: 3000,
          verifyCertificate: true,
        })
        network['websocketClients'] = clients
        raw['network'] = network

        writeFileSync(path, JSON.stringify(raw, null, 2), 'utf8')
        files.push({ path, changed: true, already: false })
      } catch {
        // 单个文件坏了不影响其它
      }
    }
  }

  return { files }
}
