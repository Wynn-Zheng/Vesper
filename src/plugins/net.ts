import { lookup } from 'node:dns/promises'
import { info, warn } from '../core/log.ts'

/**
 * 插件的网络出口。
 *
 * 为什么需要一层：`ctx.fetch` 原来是裸的 `fetch(url)`，插件想打哪儿打哪儿。
 * 插件本身不是恶意也不一定安全——一个「查天气」的小插件最容易犯的错就是
 * 把用户给的 URL 直接透传出去，于是 `192.168.1.1` 这种内网地址也能打。
 * 这就是 SSRF：机器人在家里的内网，内网里可能有路由器、NAS、摄像头。
 *
 * 三道闸，从硬到软：
 *   ① 协议：只放 http/https。file://、gopher:// 这些直接拒
 *   ② 地址：解析出来的 IP 落在内网/回环/链路本地 → 拒。这条不可配置
 *      （除非用户明确打开「允许内网」，用来调本机服务）
 *   ③ 域名：白名单/黑名单，用户可配
 *
 * 关于 DNS rebinding：先解析再请求，中间域名仍可能被改指向内网。
 * 要彻底封死得自己接管 socket 解析，代价太大；这里的威胁模型是
 * 「插件写错了」和「插件被诱导」，不是「有人在专门打你这台机器」。
 */

export interface NetPolicy {
  /** 允许的域名白名单。空 = 不限域名（但仍然禁内网） */
  白名单: string[]
  /** 明确禁止的域名，优先于白名单 */
  黑名单: string[]
  /** 允许访问内网和本机（要调本地服务时才开） */
  允许内网: boolean
  /** 单次请求超时（秒） */
  超时: number
  /** 最多跟几次重定向 */
  最多跳转: number
}

/** 没配就是这套：不限域名，但内网一律打不进去 */
export const DEFAULT_NET_POLICY: NetPolicy = {
  白名单: [],
  黑名单: [],
  允许内网: false,
  超时: 20,
  最多跳转: 5,
}

/**
 * 内网地址段。这些一律拒绝，除非 允许内网 = true。
 *
 * 名单里专门留了 169.254.169.254 —— 云厂商的元数据服务，
 * 那上面能拿到机器身份凭据，是 SSRF 最常见的靶子。
 */
const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // 「本网络」
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 回环
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    // 只接受十进制：0x7f.1 这种写法 URL 里不会出现，出现了也当非法
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = (n << 8) | v
  }
  // >>> 0 把有符号结果转回无符号
  return n >>> 0
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return false
  for (const [base, bits] of PRIVATE_V4) {
    const b = ipv4ToInt(base)
    if (b === null) continue
    // 掩码比较：bits 位以内相同就算命中
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    if ((n & mask) >>> 0 === (b & mask) >>> 0) return true
  }
  return false
}

function isPrivateV6(ip: string): boolean {
  const low = ip.toLowerCase().replace(/^\[|\]$/g, '')
  if (low === '::' || low === '::1') return true
  // IPv4-mapped 点分形式：::ffff:192.168.1.1
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low)
  if (dotted) return isPrivateV4(dotted[1]!)
  // IPv4-mapped 十六进制形式：::ffff:7f00:1
  //
  // 这一条是补的：WHATWG URL 会把 `[::ffff:127.0.0.1]` 归一化成 `[::ffff:7f00:1]`，
  // 只认点分的话 `http://[::ffff:127.0.0.1]:6379/` 能直接打穿内网
  // （实测 checkUrl 返回 ok:true）。
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low)
  if (hex) {
    const a = parseInt(hex[1]!, 16)
    const b = parseInt(hex[2]!, 16)
    return isPrivateV4(`${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`)
  }
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return true // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(low)) return true // fe80::/10 链路本地
  if (/^ff[0-9a-f]{2}:/.test(low)) return true // ff00::/8 组播
  if (/^64:ff9b:/.test(low)) return true // 64:ff9b::/96 NAT64（可能映射到内网）
  return false
}

/** 这个地址能不能出去。不认识的写法按"不安全"算，宁可错杀 */
export function isPrivateAddress(ip: string): boolean {
  const low = ip.toLowerCase()
  if (low.includes(':')) return isPrivateV6(low)
  return isPrivateV4(low)
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(':')
}

/** 域名 → IP 列表。解析不出来直接抛（不放过"解析失败"这条路径） */
async function resolveHost(host: string): Promise<string[]> {
  if (isIpLiteral(host)) return [host]
  const res = await lookup(host, { all: true })
  return res.map((r) => r.address)
}

/** 白名单匹配：`api.example.com` 精确匹配；`.example.com` 后缀匹配；`*.example.com` 同后缀 */
export function hostAllowed(host: string, list: string[]): boolean {
  const h = host.toLowerCase()
  return list.some((raw) => {
    const p = raw.trim().toLowerCase()
    if (!p) return false
    if (p === '*') return true
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(p.slice(1))
    if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p)
    return h === p
  })
}

export interface NetCheck {
  ok: boolean
  reason?: string
}

/** 单独一个地址能不能打——给"想在请求前先问一句"的插件用，也给测试用 */
export async function checkUrl(url: string, policy: NetPolicy): Promise<NetCheck> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, reason: `不是合法的 URL：${url}` }
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http/https，收到 ${u.protocol}` }
  }

  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, reason: 'URL 里没有域名' }

  if (policy.黑名单.length && hostAllowed(host, policy.黑名单)) {
    return { ok: false, reason: `域名在黑名单里：${host}` }
  }
  if (policy.白名单.length && !hostAllowed(host, policy.白名单)) {
    return { ok: false, reason: `域名不在白名单里：${host}` }
  }
  if (policy.允许内网) return { ok: true }

  let addrs: string[]
  try {
    addrs = await resolveHost(host)
  } catch {
    return { ok: false, reason: `解析不出去：${host}` }
  }
  if (!addrs.length) return { ok: false, reason: `解析不出去：${host}` }

  for (const addr of addrs) {
    if (isPrivateAddress(addr)) {
      return { ok: false, reason: `指向内网地址（${addr}）：${host}` }
    }
  }
  return { ok: true }
}

export type SafeFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * 造一个受策略约束的 fetch。
 *
 * 重定向自己跟，不交给 fetch：`redirect: 'follow'` 时后续几跳完全不经过检查，
 * 一个公网 URL 302 到 127.0.0.1 就绕过全部限制了。
 */
export function createSafeFetch(policy: NetPolicy, pluginId: string): SafeFetch {
  return async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
    let target = url
    const signal = init?.signal

    for (let hop = 0; hop <= policy.最多跳转; hop++) {
      const check = await checkUrl(target, policy)
      if (!check.ok) {
        warn(`插件 ${pluginId} 的网络请求被拦下：${check.reason}`)
        throw new Error(`网络请求被拦下：${check.reason}`)
      }

      // 超时合并：调用方自己的 signal 也要能中断
      const timeout = AbortSignal.timeout(Math.max(1, policy.超时) * 1000)
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout

      const res = await fetch(target, { ...init, redirect: 'manual', signal: merged })

      // 不是重定向就到此为止
      if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) {
        return res
      }

      if (hop === policy.最多跳转) {
        throw new Error(`重定向次数太多（超过 ${policy.最多跳转} 次）`)
      }
      // 相对地址按当前地址补全；下一跳会重新过一遍全部检查
      target = new URL(res.headers.get('location')!, target).toString()
      info(`插件 ${pluginId} 跟随重定向 → ${target}`)
    }

    throw new Error('重定向次数太多')
  }
}
