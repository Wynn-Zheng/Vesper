import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { info, warnAt } from '../core/log.ts'

const ROOT = 'persona'
// 快照必须放在 persona/ 外面：cpSync 不允许把目录复制进自己的子目录
const DIR = 'data/versions'

/** 保留多少天 */
const KEEP_DAYS = 30
/** 快照总数上限：只按天数留挡不住手动/导入/测试的高频快照 */
const MAX_SNAPSHOTS = 60

export interface SnapshotMeta {
  id: string
  reason: string
  at: number
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function ymd(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function ensure(p: string): string {
  mkdirSync(p, { recursive: true })
  return p
}

/** persona/ 下所有文件的最新修改时间 */
export function latestMtime(dir = ROOT): number {
  if (!existsSync(dir)) return 0
  let max = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.versions') continue
    const p = join(dir, e.name)
    try {
      if (e.isDirectory()) max = Math.max(max, latestMtime(p))
      else max = Math.max(max, statSync(p).mtimeMs)
    } catch {
      /* 文件正在变，跳过 */
    }
  }
  return max
}

/**
 * 快照要跳过哪些路径。
 *
 * 除了自带的 `.versions`，还**跳掉表情包库**：
 *   - 它跟"人格/记忆"不是一回事，回滚人格时不该把表情包也回滚回去；
 *   - 它会随使用一直长大（群里发的每张图都进库），而快照保留 60 份 ——
 *     一张 100KB 的图 × 几千张 × 60 份，磁盘会直接炸。
 * 现在 personas 才 0.25MB 看不出问题，等用久了才会爆。
 */
export function isSnapshotExcluded(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  return p.includes('.versions') || /(^|\/)emoji(\/|$)/.test(p)
}

/** 给 persona/ 拍一张快照。返回 id，失败返回 null。 */
export function snapshot(reason: string): string | null {
  try {
    ensure(DIR)
    const id = stamp()
    const dest = join(DIR, id)
    if (existsSync(dest)) return id

    cpSync(ROOT, dest, {
      recursive: true,
      filter: (src) => !isSnapshotExcluded(src),
    })
    writeFileSync(join(dest, '.meta.json'), JSON.stringify({ id, reason, at: Date.now() } satisfies SnapshotMeta), 'utf8')
    prune()
    info(`已保存人格快照 ${id}（${reason}）`)
    return id
  } catch (err) {
    warnAt(`快照失败：${String(err)}`)
    return null
  }
}

export function listSnapshots(): SnapshotMeta[] {
  if (!existsSync(DIR)) return []
  const out: SnapshotMeta[] = []
  for (const e of readdirSync(DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const meta = join(DIR, e.name, '.meta.json')
    try {
      out.push(JSON.parse(readFileSync(meta, 'utf8')) as SnapshotMeta)
    } catch {
      out.push({ id: e.name, reason: 'unknown', at: 0 })
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1))
}

/** 回滚到某个快照。回滚前会先给当前状态拍一张。 */
export function restore(id: string): boolean {
  const src = join(DIR, id)
  if (!existsSync(src)) return false
  snapshot('before-restore')
  cpSync(src, ROOT, {
    recursive: true,
    filter: (s) => !s.includes('.versions') && !s.endsWith('.meta.json'),
  })
  info(`已回滚到 ${id}`)
  return true
}

/** 只留最近 KEEP_DAYS 天的快照，并且总数不超过 MAX_SNAPSHOTS 张 */
function prune(): void {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000
  const all = listSnapshots().sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  // 只按天数留不够：手动/导入/测试会一天拍几十张，磁盘会被撑爆（实测 4 天 395 张 50MB）。
  const keep = new Set(all.slice(0, MAX_SNAPSHOTS).map((s) => s.id))
  for (const s of all) {
    const tooOld = !!s.at && s.at < cutoff
    if (tooOld || !keep.has(s.id)) {
      try {
        rmSync(join(DIR, s.id), { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

/** 今天拍过了吗 */
function hasToday(): boolean {
  const today = ymd()
  return listSnapshots().some((s) => s.id.startsWith(today))
}

/**
 * 每天一张快照。
 * 以前是"每 30 分钟检查改动就拍"，一天能攒几十张，纯属浪费——
 * 人格是按天在长的，一天一张足够看清楚变化。
 *
 * 启动时补拍（如果今天还没有），之后每小时检查一次跨天。
 */
export function startAutoSnapshot(): () => void {
  if (!hasToday()) snapshot('daily')
  const timer = setInterval(() => {
    if (!hasToday()) snapshot('daily')
  }, 3600_000)
  timer.unref?.()
  return () => clearInterval(timer)
}
