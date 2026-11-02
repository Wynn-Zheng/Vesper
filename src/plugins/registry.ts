/**
 * 插件目录扫描：把 rootDir 下的每个子目录当成一个插件。
 * 单个目录出问题只记一条 error 并跳过，不影响其它插件。
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseManifest } from './manifest.ts'
import type { PluginManifest } from './manifest.ts'

export type RegisteredPlugin = {
  manifest: PluginManifest
  dir: string
  enabled: boolean
}

export type PluginScanError = {
  /** 目录名（清单没读出来时拿不到 manifest.id，用目录名定位） */
  id: string
  message: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function scanPlugins(
  rootDir: string,
): Promise<{ plugins: RegisteredPlugin[]; errors: PluginScanError[]; warnings: PluginScanError[] }> {
  const root = resolve(rootDir)
  // 根目录不存在是正常情况（还没装过插件），直接返回空结果
  if (!existsSync(root)) return { plugins: [], errors: [], warnings: [] }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // 根目录不可读时也按空目录处理，不让扫描本身抛错
    return { plugins: [], errors: [], warnings: [] }
  }

  const plugins: RegisteredPlugin[] = []
  const errors: PluginScanError[] = []
  // 提示（不是失败）：比如目录名和清单 id 不一致。
  // 和 errors 分开，因为"有 N 个插件坏了"和"有 N 个插件建议改下目录名"是两件事。
  const warnings: PluginScanError[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const dir = join(root, entry.name)
    const manifestPath = join(dir, 'plugin.json')

    let raw: unknown
    try {
      const text = await readFile(manifestPath, 'utf8')
      // 记事本保存的 JSON 带 BOM（\uFEFF），JSON.parse 会直接抛
      raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch (err) {
      // 文件不存在、读失败、JSON 语法错误都记一条，然后跳过这个目录
      errors.push({ id: entry.name, message: `读取或解析 plugin.json 失败：${errorMessage(err)}` })
      continue
    }

    const parsed = parseManifest(raw)
    if (!parsed.ok) {
      errors.push({ id: entry.name, message: `清单校验失败：${parsed.errors.join('; ')}` })
      continue
    }

    plugins.push({
      manifest: parsed.manifest,
      dir,
      // 子目录里存在名为 disabled 的标记文件即视为禁用
      enabled: !existsSync(join(dir, 'disabled')),
    })

    // 目录名和清单 id 不一致：能加载，但"卸载/停用"到底动哪个目录很容易搞混。
    // 用户手动复制目录改名时会撞上（文档里还教过这么干）。
    // 记一条**提示**（不影响加载），控制台会在列表顶部显示。
    if (parsed.manifest.id !== entry.name) {
      warnings.push({
        id: entry.name,
        message: `目录名（${entry.name}）和清单里的 id（${parsed.manifest.id}）不一样。能正常跑，但卸载/停用按目录走，建议改成一致。`,
      })
    }
  }

  // 按 id 升序，保证多次扫描顺序稳定
  plugins.sort((a, b) => {
    if (a.manifest.id < b.manifest.id) return -1
    if (a.manifest.id > b.manifest.id) return 1
    return 0
  })

  return { plugins, errors, warnings }
}
