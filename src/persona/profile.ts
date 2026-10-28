import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmOptions } from '../llm/types.ts'
import { info } from '../core/log.ts'
import { chat } from '../llm/deepseek.ts'
import { loadEpisodes } from '../memory/store.ts'
import { loadFacts } from '../memory/facts.ts'
import { accountIdsOf, personDir } from '../people/store.ts'
import { writeAtomic } from '../store/fs.ts'

const SYSTEM = `你在给一个人写"他是谁"的画像，给一个正在学着了解他的朋友看。
写成 150~250 字的短文，像一个人在心里对另一个人的评价。
不要列点，不要标题，不要"总结如下"。
只写你确定的；不确定的不要写。用第三人称"他"。
不要写他告诉你的私事，只写你对这个人的整体印象。
下面会给你"关于他的事实"——那些事实会单独记住、单独出现在你脑子里，
**不要在画像里复述它们**（别写"他在准备考研"这种句子）。
要写的是从这些事实里看出来的东西：他是什么样的人、怎么和他相处、你在他身上注意到什么。`

function profileFile(personId: string): string {
  return join(personDir(personId), 'profile.md')
}

export function loadProfile(personId: string): string {
  const f = profileFile(personId)
  if (!existsSync(f)) return ''
  try {
    return readFileSync(f, 'utf8').trim()
  } catch {
    return ''
  }
}

export function saveProfile(personId: string, text: string): void {
  writeAtomic(profileFile(personId), `${text.trim()}\n`)
}

export function profilePath(personId: string): string {
  return profileFile(personId)
}

/** 用这个人自己的事实和经历重写画像 */
export async function refreshProfile(llm: LlmOptions, personId: string): Promise<boolean> {
  // 画像是它自己的印象，可以基于全部事实；
  // 但 prompt 里已经要求"不写私事细节"，所以产物本身是安全的。
  const facts = loadFacts(personId)
  if (facts.length < 3) return false

  const accounts = accountIdsOf(personId)
  const episodes = loadEpisodes()
    .filter((e) => accounts.some((a) => e.scope === `private:${a}`))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 15)

  const material = [
    '关于他的事实（不包含私事）：',
    ...facts.map((f) => `- ${f.text}`),
    '',
    '一起经历过的：',
    ...episodes.map((e) => `- ${e.date}｜${e.title}${e.emotion ? `（${e.emotion}）` : ''}`),
  ].join('\n')

  try {
    const res = await chat(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: material },
      ],
      { ...llm, maxTokens: 400, temperature: 0.4 },
    )
    const text = res.text.trim()
    if (text.length < 20) return false
    saveProfile(personId, text)
    info('人物画像已更新', { person: personId, chars: text.length })
    return true
  } catch {
    return false
  }
}
