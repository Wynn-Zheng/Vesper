/**
 * 能力清单（B-19）。
 *
 * 这份清单是喂给自我反思的，它会照着清单说"我能做什么"。所以清单本身
 * 必须准：把定时任务干的事说成"你能做"，它就会答应人"我现在去B站看看"，
 * 然后什么也做不出来。
 *
 * 这里锁住的是**分组**，而不只是文案：`byModel` 为 false 的必须进
 * "系统会做，但你在对话里做不了"那一组。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULTS } from '../src/core/config.ts'
import { listAbilities, renderAbilities } from '../src/self/abilities.ts'
import { tools } from '../src/tools/registry.ts'

function find(list: ReturnType<typeof listAbilities>, name: string) {
  const a = list.find((x) => x.name === name)
  assert.ok(a, `能力清单里没有「${name}」`)
  return a
}

test('硬事实：这几条永远是做不到', () => {
  const list = listAbilities(DEFAULTS)
  for (const name of ['执行代码', '打开网页/搜索', '看视频画面', '打开文件']) {
    assert.equal(find(list, name).available, false, `${name} 不该说成能做到`)
    assert.equal(find(list, name).byModel, false)
  }
})

test('定时任务干的事不能算成模型的能力', () => {
  const list = listAbilities(DEFAULTS)
  // 这三个的入口都不在工具注册表里：
  //  刷视频 → scheduler 的定时任务；发空间 → 控制台的 composeDraft；查 B站 → watch.ts
  for (const name of ['刷视频', '发空间', '查 B站', '看图片', '记事']) {
    assert.equal(find(list, name).byModel, false, `${name} 不该算成模型能主动做的事`)
  }
})

test('工具注册表里有的，才算模型能主动用', () => {
  const list = listAbilities(DEFAULTS)
  const registered = new Set(tools.list().map((t) => t.name))
  for (const a of list) {
    if (registered.has(a.name)) assert.equal(a.byModel, true, `${a.name} 是注册过的工具，应算模型能做`)
  }
})

test('刷视频跟着配置开关走', () => {
  const off = listAbilities(DEFAULTS)
  assert.equal(find(off, '刷视频').available, false)

  const onRules = structuredClone(DEFAULTS)
  onRules.外部.刷视频.开启 = true
  const on = listAbilities(onRules)
  assert.equal(find(on, '刷视频').available, true)
  assert.equal(find(on, '刷视频').byModel, false, '开了也还是定时任务在刷')
})

test('桌面工具没注册时，配置开着也不能说能看屏幕', () => {
  const rules = structuredClone(DEFAULTS)
  rules.电脑操作.enabled = true
  rules.电脑操作.允许操作 = true
  const list = listAbilities(rules)
  const deskRegistered = tools.list().some((t) => t.name === 'screenshot')
  const look = find(list, '看他的屏幕')
  assert.equal(look.available, deskRegistered, '配置开着但工具没注册时，必须说实际看不到')
  if (!deskRegistered) assert.match(look.hint, /没装上|看不到/)
})

test('渲染分三组，系统能力不能混进「你能做的」', () => {
  const rules = structuredClone(DEFAULTS)
  rules.外部.刷视频.开启 = true
  rules.外部.发空间.开启 = true
  const text = renderAbilities(listAbilities(rules))

  const iCan = text.indexOf('你在对话里能主动做的')
  const iSys = text.indexOf('系统会做，但你在对话里做不了')
  const iNo = text.indexOf('现在还没接上的')
  assert.ok(iCan >= 0 && iSys >= 0 && iNo >= 0, '三组标题都要在')
  assert.ok(iCan < iSys && iSys < iNo, '顺序：能做的 → 系统做的 → 做不到的')

  // 「发空间」和「刷视频」必须落在第二组，不能出现在第一组里
  const groupCan = text.slice(iCan, iSys)
  const groupSys = text.slice(iSys, iNo)
  assert.ok(groupSys.includes('发空间'), '发空间应在「系统会做」组')
  assert.ok(groupSys.includes('刷视频'), '刷视频应在「系统会做」组')
  assert.ok(!groupCan.includes('发空间'), '发空间不该出现在「你能做的」组')
  assert.ok(!groupCan.includes('刷视频'), '刷视频不该出现在「你能做的」组')
})
