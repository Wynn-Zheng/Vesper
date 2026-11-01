import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { createEmojiStore } from '../emoji/store.ts'
import { tagEmoji } from '../emoji/tag.ts'
import type { LlmOptions } from '../llm/types.ts'

/**
 * 后台给表情包补语义标签。
 *
 * 为什么不入库时当场打标：收表情包发生在聊天消息的处理路径上，
 * 每条都调一次视觉模型会拖慢回复，而且大多数消息里根本没有图。
 * 这里攒一批、空闲时慢慢补，聊天不受影响。
 *
 * 为什么是一次几张而不是全量：库可能攒了几百张，
 * 一口气跑完会连着调几百次模型——既慢又贵，还容易撞限流。
 */

const ROOT = join('persona', 'emoji')

export interface EmojiTaggerOptions {
  llm: LlmOptions
  getRules: () => Rules
  /** 每轮最多打几张，默认 5 */
  batch?: number
  /** 两轮之间隔多久，默认 10 分钟 */
  intervalMs?: number
}

/** 没有语义标签的表情包 = mood 空且 tags 空 */
function untagged(item: { mood: string; tags: string[] }): boolean {
  return !item.mood && (!item.tags || item.tags.length === 0)
}

export function startEmojiTagger(opts: EmojiTaggerOptions): () => void {
  const batch = opts.batch ?? 5
  const interval = opts.intervalMs ?? 10 * 60_000
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  async function runOnce(): Promise<number> {
    const rules = opts.getRules()
    // 视觉模型没开就不用折腾了：打标用的就是那个模型
    if (!rules.表情包?.开启 || !rules.视觉?.开启) return 0

    const store = createEmojiStore(ROOT, { libraryCap: rules.表情包.库存上限 })
    const pending = (await store.list()).filter(untagged)
    if (!pending.length) return 0

    const visionModel =
      rules.视觉.模型 || process.env['DEEPSEEK_VISION_MODEL'] || 'deepseek-v4-flash-vision-exp'
    const llm: LlmOptions = { ...opts.llm, model: visionModel }

    let done = 0
    for (const item of pending.slice(0, batch)) {
      let buffer: Buffer
      try {
        buffer = await readFile(join(ROOT, item.file))
      } catch {
        // 文件没了：list() 下次会自己清掉这条，这里直接跳过
        continue
      }
      const ext = item.file.split('.').pop() ?? 'png'
      const tags = await tagEmoji({ buffer, ext }, llm)
      if (!tags) continue
      if (await store.setMeta(item.id, tags)) done++
    }

    if (done > 0) {
      const left = pending.length - done
      info(`表情包打标：这批 ${done} 张${left > 0 ? `，还有 ${left} 张没打` : '，全部打完'}`)
    }
    return done
  }

  async function tick(): Promise<void> {
    try {
      await runOnce()
    } catch (err) {
      warnAt('表情包打标出错，下轮再试', { err: String(err).slice(0, 100) })
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval)
  }

  // 启动后先等两分钟：别和 distill / 主动消息抢同一时间点调模型
  timer = setTimeout(() => void tick(), 120_000)
  info('表情包打标已启动（每 10 分钟补几张）')

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
