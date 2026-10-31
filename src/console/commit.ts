/**
 * 「计入记忆」—— 控制台聊的内容，用户说一声就升格成正式记忆。
 *
 * 两条路（用户选了两个都做）：
 *   1. 模型自己判断：他说"这段记下来"，模型调 commit_console_memory 工具
 *   2. 页面按钮：他点「把这段计入记忆」，直接调 /api/chat/commit
 *
 * 落地方式：把最近 N 轮控制台对话整理成一条 episode，
 * scope 用**主人的私聊 scope**（private:qq-<owner>），这样 QQ 那边就能想起。
 * episode 里标 source: console，以后能看出"这是从控制台转过来的"。
 */
import { existsSync, readFileSync } from 'node:fs'

const CHAT = 'data/console/chat.jsonl'

export type ConsoleTurn = { at: number; role: 'user' | 'it'; text: string }

/** 读最近 n 轮（1 轮 = 我一句 + 它一句） */
export function recentConsoleTurns(rounds = 6): ConsoleTurn[] {
  try {
    if (!existsSync(CHAT)) return []
    const lines = readFileSync(CHAT, 'utf8').split('\n').filter((x) => x.trim())
    const out: ConsoleTurn[] = []
    for (const line of lines.slice(-rounds * 2)) {
      try {
        const j = JSON.parse(line) as Partial<ConsoleTurn>
        if (typeof j.text === 'string' && (j.role === 'user' || j.role === 'it')) {
          out.push({ at: Number(j.at) || 0, role: j.role, text: j.text })
        }
      } catch {
        /* 坏行跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}

/** 把最近几轮拼成一段话，交给 saveEpisode */
export function renderConsoleTranscript(rounds = 6): string {
  const turns = recentConsoleTurns(rounds)
  if (!turns.length) return ''
  return turns.map((t) => (t.role === 'user' ? `我：${t.text}` : `它：${t.text}`)).join('\n')
}

/**
 * 把控制台最近的对话记成一条正式 episode。
 *
 * 写到**主人私聊的 scope**（`private:qq-<owner>`），所以 QQ 那边能想起来。
 * 标题里带「控制台」三个字，以后翻记忆能看出这条是从哪来的。
 */
export async function commitConsoleToMemory(opts: {
  ownerQQ: string
  rounds?: number
  title?: string
}): Promise<{ ok: boolean; detail: string }> {
  const owner = String(opts.ownerQQ || '').trim()
  if (!owner) return { ok: false, detail: '不知道主人 QQ 是多少（OWNER_QQ 没配）' }

  const transcript = renderConsoleTranscript(opts.rounds ?? 6)
  if (!transcript.trim()) return { ok: false, detail: '控制台还没有对话可记' }

  const { saveEpisode } = await import('../memory/store.ts')
  const now = new Date()
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const title = (opts.title || '在控制台聊了一会儿').slice(0, 40)

  try {
    const id = saveEpisode({
      // saveEpisode 会用这个拼文件名；带时间戳避免同一天多条撞号
      id: `${day}-console-${String(now.getTime()).slice(-5)}`,
      date: day,
      scope: `private:qq-${owner}`,
      importance: 5,
      title: `${title}（控制台）`,
      body: `（这段是在控制台里聊的，用户要求记下来）\n\n${transcript}`,
      lastRecalled: 0,
    })
    return { ok: true, detail: `已记进记忆：${id}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 启动时把控制台对话倒回 session。
 *
 * 为什么要这个：session 是内存态（`session.ts` 的设计——只有触发上下文压缩
 * 才落盘），重启后模型就"忘了"上一轮在控制台说过什么，但页面上的记录还在。
 * 两边不一致会让人以为它失忆了。
 *
 * 幂等：只往**空**的 session 里倒（启动时本来就是空的），
 * 已经有内容就跳过，避免每次重启把同一段话塞两遍。
 */
export async function restoreConsoleSession(ownerQQ: string, rounds = 20): Promise<number> {
  const owner = String(ownerQQ || '').trim()
  if (!owner) return 0

  const turns = recentConsoleTurns(rounds)
  if (!turns.length) return 0

  const { getTurns, pushTurn } = await import('../loop/session.ts')
  const key = `private:console-${owner}`
  if (getTurns(key).length > 0) return 0

  for (const t of turns) {
    pushTurn(
      key,
      {
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.text,
        at: t.at,
      },
      60,
    )
  }
  return turns.length
}
