import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Rules } from '../core/config.ts'
import { info, warnAt } from '../core/log.ts'
import { createEmojiStore } from '../emoji/store.ts'
import { tagEmoji, type EmojiTags } from '../emoji/tag.ts'
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

const DEFAULT_ROOT = join('persona', 'emoji')

export interface EmojiTaggerOptions {
  llm: LlmOptions
  getRules: () => Rules
  /** 每轮最多打几张，默认 5 */
  batch?: number
  /** 两轮之间隔多久，默认 10 分钟 */
  intervalMs?: number
  /** 表情包库目录，默认 persona/emoji（测试用来指向临时目录） */
  root?: string
  /** 打标实现，默认 tagEmoji（测试可注入，免得真去调模型） */
  tag?: (image: { buffer: Uint8Array; ext: string }, llm: LlmOptions) => Promise<EmojiTags | null>
}

export interface EmojiTaggerRunner {
  /** 跑一轮。返回这一轮成功打了几张。 */
  runOnce(): Promise<number>
  /** 当前每张图累计失败了几次（测试用） */
  failures(): Map<string, number>
}

/** 没有语义标签的表情包 = mood 空且 tags 空 */
function untagged(item: { mood: string; tags: string[] }): boolean {
  return !item.mood && (!item.tags || item.tags.length === 0)
}

/**
 * 把打标循环抽出来，不挂定时器。
 *
 * 抽出来的原因：`startEmojiTagger` 内部是 `setTimeout` 驱动，
 * 一轮要等 10 分钟，行为测不了。「坏图会不会堵住队头」这种事只能靠
 * 连续跑几轮来验证（B-28），所以这里暴露一个能手动 `runOnce()` 的 runner。
 */
export function createEmojiTaggerRunner(opts: EmojiTaggerOptions): EmojiTaggerRunner {
  const batch = opts.batch ?? 5
  const root = opts.root ?? DEFAULT_ROOT
  const tag = opts.tag ?? tagEmoji
  // 打标失败的次数。以前每轮都取 pending 的前 batch 张，只要有几张坏图打不出来，
  // 它们就一直占着队头，后面的永远轮不到 —— 表现为"库存越攒越多，标签一直不长"。
  const fails = new Map<string, number>()
  const MAX_FAILS = 3

  async function runOnce(): Promise<number> {
    const rules = opts.getRules()
    // 视觉模型没开就不用折腾了：打标用的就是那个模型
    if (!rules.表情包?.开启 || !rules.视觉?.开启) return 0

    const store = createEmojiStore(root, { libraryCap: rules.表情包.库存上限 })
    const pending = (await store.list()).filter(untagged)
    // 连续失败太多次的先让开，别堵着队头
    const usable = pending.filter((x) => (fails.get(x.id) ?? 0) < MAX_FAILS)
    if (!usable.length) {
      if (pending.length) warnAt('表情包打标：剩下的都反复失败，先搁置', { 数量: pending.length })
      return 0
    }

    const visionModel =
      rules.视觉.模型 || process.env['DEEPSEEK_VISION_MODEL'] || 'deepseek-v4-flash-vision-exp'
    const llm: LlmOptions = { ...opts.llm, model: visionModel }

    let done = 0
    for (const item of usable.slice(0, batch)) {
      let buffer: Buffer
      try {
        buffer = await readFile(join(root, item.file))
      } catch {
        // 文件没了：list() 下次会自己清掉这条，这里直接跳过
        continue
      }
      const ext = item.file.split('.').pop() ?? 'png'
      const tags = await tag({ buffer, ext }, llm)
      if (!tags) {
        const n = (fails.get(item.id) ?? 0) + 1
        fails.set(item.id, n)
        if (n >= MAX_FAILS) warnAt('表情包打标连续失败，这一张先跳过', { id: item.id, 次数: n })
        continue
      }
      fails.delete(item.id)
      // 打标成功也清掉失败记录：这张图能打出来，之前的失败是暂时的
      if (await store.setMeta(item.id, tags)) done++
    }

    if (done > 0) {
      const left = pending.length - done
      info(`表情包打标：这批 ${done} 张${left > 0 ? `，还有 ${left} 张没打` : '，全部打完'}`)
    }
    return done
  }

  return { runOnce, failures: () => fails }
}

export function startEmojiTagger(opts: EmojiTaggerOptions): () => void {
  const interval = opts.intervalMs ?? 10 * 60_000
  const runner = createEmojiTaggerRunner(opts)
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  async function tick(): Promise<void> {
    try {
      await runner.runOnce()
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
