import { loadSelf, saveSelf } from '../src/self/store.ts'
import { readFileSync, copyFileSync } from 'node:fs'

const F = 'persona/self.md'
copyFileSync(F, F + '.probe-bak')

const before = readFileSync(F, 'utf8')
console.log('=== 原文件长度 ===', before.length)

const doc = loadSelf()
console.log('\n=== loadSelf() 解析结果 ===')
console.log('  名字     :', JSON.stringify(doc.name))
console.log('  取名原因 :', JSON.stringify(doc.nameReason))
console.log('  traits   :', JSON.stringify(doc.traits))
console.log('  about 长度:', doc.about.length)
console.log('  about 开头:', JSON.stringify(doc.about.slice(0, 40)))
console.log('  abilities 长度:', doc.abilities.length)
console.log('  abilities 开头:', JSON.stringify(doc.abilities.slice(0, 40)))
console.log('  thinking 长度:', doc.thinking.length)
console.log('  thinking 开头:', JSON.stringify(doc.thinking.slice(0, 40)))

console.log('\n=== 模拟一次「保存自述」（about 原样回写）===')
saveSelf({ ...doc, about: doc.about })
const after = readFileSync(F, 'utf8')
console.log('  写回后长度:', after.length, '（原', before.length, '）')

// 对比关键内容还在不在
for (const key of ['还是那个先担心', '折纸那步', '能想事情']) {
  console.log(`  含「${key}」: ${after.includes(key) ? '还在 ✓' : '丢了 ✗'}`)
}

console.log('\n=== 写回后的文件 ===')
console.log(after)
