import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// 不能用相对路径：--test-isolation=none 下所有测试共用一个进程，
// 有的测试会 chdir 到临时目录，相对路径会直接找不到文件（实测 ENOENT）。
const ROOT = join(import.meta.dirname, '..')
import { test } from 'node:test'

/**
 * 配置文件必须用 writeAtomic 写。
 *
 * 踩过的坑（BUG-06 / BUG-19）：rules.yaml 被 writeFileSync 直接覆盖，
 * 写到一半崩了就是一个半截 YAML —— 下次启动会**静默回落到默认配置**，
 * 用户看到的是"我的设置全没了"，而且没有任何报错。
 * .env 更严重：半截文件 = 读不到 API Key = 它不说话了。
 *
 * 这条测试防止以后又有人图省事写 `writeFileSync('persona/rules.yaml', …)`。
 * 之前修了 3 处，漏了 4 处，就是因为没有这条。
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(join(ROOT, 'src'))

test('控制台代码里不允许非原子的 writeFileSync（只有下载的 tar 可以例外）', () => {
  const bad: string[] = []
  for (const f of files.filter((x) => x.includes('console'))) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/writeFileSync\(/g)) {
      const line = src.slice(0, m.index).split('\n').length
      const text = src.split('\n')[line - 1] ?? ''
      // 例外：更新包的 tar。它先校验 sha256 再落盘，写坏了下次解压会报错，
      // 不会静默生效；而且动辄上百 MB，走原子写要来回拷一遍。
      if (/writeFileSync\(tar\b/.test(text)) continue
      bad.push(`${f}:${line}`)
    }
  }
  assert.deepEqual(bad, [], `这些地方应该改成 writeAtomic：\n${bad.join('\n')}`)
})

test('任何地方都不许直接覆盖 persona/ 下的文件', () => {
  const bad: string[] = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    if (/writeFileSync\(\s*['"`]persona\//.test(src)) bad.push(f)
  }
  assert.deepEqual(bad, [], `persona/ 下的文件必须原子写：${bad.join(', ')}`)
})

test('writeAtomic 本身确实是"先写临时文件再改名"', () => {
  // 不是看注释，是看行为：临时文件名的唯一性决定了并发写不会互相踩。
  const src = readFileSync(join(ROOT, 'src/store/fs.ts'), 'utf8')
  assert.match(src, /renameSync\(tmp, file\)/, '要 rename，不能直接覆盖')
  assert.match(src, /process\.pid/, '临时名要带 pid')
  assert.match(src, /Math\.random/, '临时名要带随机段，防并发同名')
})

test('备份/恢复这种"整个目录"的操作不用 writeFileSync 逐文件覆盖', () => {
  // 只是提醒：backup.ts 用的是 cpSync + writeAtomic 混用，
  // 如果以后有人改成逐文件 writeFileSync，至少这里会先失败。
  const src = readFileSync(join(ROOT, 'src/console/backup.ts'), 'utf8')
  const bad = (src.match(/writeFileSync\(/g) ?? []).length
  assert.equal(bad, 0, 'backup.ts 里出现了 writeFileSync')
})

test('src 目录还在（防止测试自己的路径写错导致永远通过）', () => {
  assert.ok(files.length > 50, `只扫到 ${files.length} 个文件，路径可能不对`)
  assert.ok(statSync(join(ROOT, 'src')).isDirectory())
})
