/**
 * 「为什么这条消息被丢掉」的诊断测试。
 *
 * rejectReason 的价值全在"和 shouldHandle 一致"上 —— 它要是撒谎，
 * 比没有更糟。所以这里同时断言两边：
 *   shouldHandle 说 false 的，rejectReason 必须给出一个非「未知原因」的说法。
 */
import { isObserveOnly, rejectReason, shouldHandle, type OBEvent, type OnebotOptions } from '../src/channel/onebot.ts'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra = ''): void {
  if (ok) {
    pass++
    console.log(`✓ ${name}`)
  } else {
    fail++
    console.log(`✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

function ev(over: Partial<OBEvent> = {}): OBEvent {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 10000,
    user_id: 1234567890,
    group_id: 111111111,
    message_id: 1,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 你在不' } }],
    raw_message: '',
    time: Math.floor(Date.now() / 1000),
    ...over,
  } as OBEvent
}

function opts(over: Partial<OnebotOptions> = {}): OnebotOptions {
  return {
    allowGroup: true,
    getPolicy: () => ({
      allowGroup: true,
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      requireAt: true,
    }),
    botNames: ['小鲸鱼'],
    ...over,
  } as OnebotOptions
}

console.log('=== 1. 正常 @ 应该放行 ===')
{
  const o = opts()
  check('群里 @ 它 → shouldHandle 放行', shouldHandle(ev(), o))
}

console.log('\n=== 2. 成员黑名单 ===')
{
  const o = opts({
    getPolicy: () => ({
      allowGroup: true,
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: ['1234567890'],
      requireAt: true,
    }),
  } as Partial<OnebotOptions>)
  check('黑名单里的人 → shouldHandle 拒绝', !shouldHandle(ev(), o))
  const r = rejectReason(ev(), o)
  check('拒绝原因说的是「成员黑名单」', r.includes('成员黑名单'), r)
  check('原因里带上了人和群', r.includes('1234567890') && r.includes('111111111'), r)
}

console.log('\n=== 3. 群黑名单 ===')
{
  const o = opts({
    getPolicy: () => ({
      allowGroup: true,
      groupAllow: [],
      groupDeny: ['111111111'],
      memberAllow: [],
      memberDeny: [],
      requireAt: true,
    }),
  } as Partial<OnebotOptions>)
  check('群黑名单 → 拒绝', !shouldHandle(ev(), o))
  check('原因说「群黑名单」', rejectReason(ev(), o).includes('群黑名单'), rejectReason(ev(), o))
}

console.log('\n=== 4. 群聊总开关没开 ===')
{
  // 总开关现在收在权限策略里（控制台可改）。注意 opts() 默认会注入一份
  // allowGroup=true 的策略，所以这里要显式覆盖策略，不能只改静态字段。
  const o = opts({
    getPolicy: () => ({
      allowGroup: false,
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      requireAt: true,
    }),
  } as Partial<OnebotOptions>)
  check('allowGroup=false → 拒绝', !shouldHandle(ev(), o))
  check('原因提到权限页或 ALLOW_GROUP', /权限|ALLOW_GROUP/.test(rejectReason(ev(), o)), rejectReason(ev(), o))
}

console.log('\n=== 5. 没 @ 也没叫名字 ===')
{
  const plain = ev({
    message: [{ type: 'text', data: { text: '今天天气不错' } }],
  } as Partial<OBEvent>)
  const o = opts()
  // 不再「拒绝」了：消息照样进来（进历史、能学这个群怎么说话），只是不回复。
  // 以前这里 return false，等于群里 90% 的话它根本没看见。
  check('没 @ 没叫名字 → 只记录不回复', isObserveOnly(plain, o))
  check('但消息本身要能进来', shouldHandle(plain, o))
}

console.log('\n=== 6. 叫了名字也算 ===')
{
  const called = ev({
    message: [{ type: 'text', data: { text: '小鲸鱼你在不' } }],
  } as Partial<OBEvent>)
  check('叫了名字 → 放行', shouldHandle(called, opts()))
}

console.log('\n=== 7. 没有文字 ===')
{
  const img = ev({ message: [{ type: 'image', data: { file: 'x.jpg' } }] } as Partial<OBEvent>)
  check('只有图片 → 拒绝', !shouldHandle(img, opts()))
  // extractText 会把图片渲染成 [图片] 占位符，所以走的是"只有占位符"分支
  const r = rejectReason(img, opts())
  check('原因说没有实际内容', r.includes('没有') || r.includes('占位符'), r)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
