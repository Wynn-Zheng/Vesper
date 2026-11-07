/**
 * 四处记忆优化的体检。
 *
 * 1. 情绪档（lambdaOfEpisode）
 * 2. 可及性（faint：很久没提但提到还能捞出来）
 * 3. distill 筛选（worthDistilling / pickForDistill）
 * 4. related 链接
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}  ${detail}`)
  }
}

const filter = await import('../src/memory/filter.ts')
const recall = await import('../src/memory/recall.ts')
const store = await import('../src/memory/store.ts')
const people = await import('../src/people/store.ts')

/* ============ 1. distill 筛选 ============ */
console.log('=== 1. distill 筛选 ===')
{
  const noise = [
    { ts: 1, text: '嗯' },
    { ts: 2, text: '好的' },
    { ts: 3, text: '哈哈哈哈' },
    { ts: 4, text: '哦哦' },
    { ts: 5, text: '行吧' },
  ]
  const content = [
    { ts: 6, text: '我答应你明天一定早点睡' },
    { ts: 7, text: '你别再问我怎么了，我不喜欢被追问' },
    { ts: 8, text: '我最近在学 Rust，感觉所有权挺绕的' },
    { ts: 9, text: '今天天气还行' },
  ]

  for (const t of noise) {
    const s = filter.worthDistilling(t, [])
    check(`「${t.text}」判为废话`, s <= -1, String(s))
  }
  for (const t of content) {
    const s = filter.worthDistilling(t, [])
    check(`「${t.text.slice(0, 10)}」判为内容`, s > -1, String(s))
  }

  // 约定/边界词加分
  const commit = filter.worthDistilling({ ts: 1, text: '我答应你明天早点睡' }, [])
  const plain = filter.worthDistilling({ ts: 2, text: '我明天早点睡' }, [])
  check('约定词加分', commit > plain, `${commit} vs ${plain}`)

  // 意外度：和已有记忆相似的不加分
  const existing = ['他最近在学 Rust，说所有权挺绕']
  const dup = filter.worthDistilling({ ts: 1, text: '他最近在学 Rust' }, existing)
  const fresh = filter.worthDistilling({ ts: 2, text: '他养了一只猫叫咪咪' }, existing)
  check('和已有记忆像的不如新的分高', fresh > dup, `${fresh} vs ${dup}`)

  // 筛选：废话全砍，内容全留
  const all = [...noise, ...content]
  const picked = filter.pickForDistill(all, [])
  check(`从 ${all.length} 条筛到 ${picked.length} 条`, picked.length < all.length, String(picked.length))
  check('一条废话都没留', picked.every((t) => !noise.some((n) => n.text === t.text)), JSON.stringify(picked.map((t) => t.text)))
  check('内容全留下了', content.every((c) => picked.some((t) => t.text === c.text)), '')
  check('保持时间顺序', picked.every((t, i) => i === 0 || picked[i - 1]!.ts < t.ts), '')

  // 全是废话时不能返回空（否则 distill 拿不到原料）
  const allNoise = filter.pickForDistill(noise, [], 0.75, 2)
  check('全是废话时不返回空', allNoise.length > 0, String(allNoise.length))

  // 少于 minKeep 时原样返回
  const few = filter.pickForDistill(content.slice(0, 2), [])
  check('条数太少时原样返回', few.length === 2, String(few.length))
}

/* ============ 2. 可及性（faint） ============ */
console.log('\n=== 2. 可及性 ===')
{
  const dir = 'data/test-faint/people/qq-999'
  mkdirSync(dir, { recursive: true })
  people.setPeopleRoot('data/test-faint/people')

  // 造一条一年前的事实 + 一条新的
  const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
  writeFileSync(
    `${dir}/facts.md`,
    `# 关于这个人的事实

## 平常

- 他养过一只猫叫咪咪（${yearAgo}，置信 0.9，公开）
- 他最近在学 Rust（2026-10-26，置信 0.9，公开）
`,
    'utf8',
  )

  const w = { 新近: 0.5, 相关: 3, 重要: 2 }

  // 不相关话题：老事实不该出现
  const r1 = recall.recall({ personId: 'qq-999', scope: 'private:999', query: '四级考得怎么样', limit: 8, weights: w })
  check('不相关话题：老事实不出现', !r1.facts.some((f) => f.text.includes('猫')), JSON.stringify(r1.facts.map((f) => f.text.slice(0, 8))))

  // 相关话题：应该捞出来并标 faint
  const r2 = recall.recall({ personId: 'qq-999', scope: 'private:999', query: '你那只猫咪咪还好吗', limit: 8, weights: w })
  const cat = r2.facts.find((f) => f.text.includes('猫'))
  check('相关话题：老事实被捞出来', !!cat, '')
  check('捞出来的标了 faint', cat?.faint === true, String(cat?.faint))

  // 渲染带标注
  if (cat) {
    const line = recall.renderRecalled(r2)
      .split('\n')
      .find((l) => l.includes('猫'))
    check('渲染带"很久没提了"标注', !!line?.includes('很久没提'), line)
  }

  // 新事实不受影响
  const r3 = recall.recall({ personId: 'qq-999', scope: 'private:999', query: '你在学什么', limit: 8, weights: w })
  check('新事实正常召回', r3.facts.some((f) => f.text.includes('Rust')), '')
  check('新事实没标 faint', r3.facts.every((f) => !f.faint), '')

  rmSync('data/test-faint', { recursive: true, force: true })
}

/* ============ 3. related 链接 ============ */
console.log('\n=== 3. related 链接 ===')
{
  const root = 'data/test-related'
  mkdirSync(`${root}/memory/episodes/private-1`, { recursive: true })
  people.setPeopleRoot(`${root}/people`)
  store.setMemoryRoot?.(`${root}/memory`)

  const a: Parameters<typeof store.saveEpisode>[0] = {
    id: '2026-10-20-01',
    date: '2026-10-20',
    scope: 'private:1',
    importance: 3,
    title: '第一条',
    body: '正文一',
  }
  const b: Parameters<typeof store.saveEpisode>[0] = {
    id: '2026-10-21-01',
    date: '2026-10-21',
    scope: 'private:1',
    importance: 3,
    title: '第二条',
    body: '正文二',
    related: ['2026-10-20-01'],
  }
  store.saveEpisode(a)
  store.saveEpisode(b)

  const loaded = store.loadEpisodes().find((e) => e.id === '2026-10-21-01')
  check('related 存下来了', JSON.stringify(loaded?.related) === '["2026-10-20-01"]', JSON.stringify(loaded?.related))

  const raw = readFileSync(`${root}/memory/episodes/private-1/2026-10-21-01.md`, 'utf8')
  check('文件里有 related 行', raw.includes('related: [2026-10-20-01]'), raw.split('---')[1]?.slice(0, 200))

  // 没有 related 的不写空行
  const rawA = readFileSync(`${root}/memory/episodes/private-1/2026-10-20-01.md`, 'utf8')
  check('没有 related 时不写空行', !rawA.includes('related:'), '')

  // recallCount 也能存
  store.saveEpisode({ ...b, recallCount: 5 })
  const again = store.loadEpisodes().find((e) => e.id === '2026-10-21-01')
  check('recallCount 存下来了', again?.recallCount === 5, String(again?.recallCount))

  rmSync(root, { recursive: true, force: true })
}

/* ============ 4. 四个模块都接上了 ============ */
console.log('\n=== 4. 接线 ===')
{
  const recallSrc = readFileSync('src/memory/recall.ts', 'utf8')
  check('recall 用了 lambdaOfEpisode', recallSrc.includes('lambdaOfEpisode(e, opts.decay)'), '')
  check('recall 有 faint 逻辑', recallSrc.includes('faint'), '')
  check('recall 用 sharedBigrams 判相关', recallSrc.includes('sharedBigrams(query'), '')
  check('recall 顺着 related 带出', recallSrc.includes('related ?? []'), '')

  const distillSrc = readFileSync('src/memory/distill.ts', 'utf8')
  check('distill 让模型填 related', distillSrc.includes('"related"'), '')
  check('distill 校验 related 是否存在', distillSrc.includes('valid.has(id)'), '')
  check('distill 把已有 episode 列表喂给模型', distillSrc.includes('knownEpisodes'), '')

  const distillerSrc = readFileSync('src/scheduler/distiller.ts', 'utf8')
  check('distiller 用了 pickForDistill', distillerSrc.includes('pickForDistill'), '')

  const factsSrc = readFileSync('src/memory/facts.ts', 'utf8')
  check('PersonFact 有 faint 字段', factsSrc.includes('faint?: boolean'), '')
  check('formatFact 不输出 faint（不写盘）', !/function formatFact[\s\S]{0,400}faint/.test(factsSrc), '')
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
