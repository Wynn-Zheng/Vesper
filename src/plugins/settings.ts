/**
 * 插件配置：persona/plugins.yaml
 *
 * 为什么单独一个文件，而不是塞进 rules.yaml：
 *   - 插件是外来的，配置结构各不一样，混进业务配置里会很难读
 *   - 卸载插件时要把它的配置一起清掉，独立文件好处理
 *
 * 格式：
 *   plugins:
 *     demo:
 *       config:
 *         某个参数: 值
 *
 * 启用状态**不在这里**：用 plugins/<id>/disabled 标记文件（跟插件目录同生共死，
 * 卸载时自动没了，不会留一份指向已删插件的孤儿配置）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export type PluginConfig = Record<string, unknown>
export type PluginSettings = Record<string, { config: PluginConfig }>

const HEADER = `# 插件配置。改完保存，重载对应插件后生效。
#
# 结构：
#   plugins:
#     <插件 id>:
#       config:
#         <键>: <值>
#
# 启用/禁用不在这里 —— 那是 plugins/<id>/disabled 标记文件的事。
`

/**
 * 读配置，并**明确告诉调用方"是不是解析失败"**。
 *
 * 为什么不能只返回 `{}`：合法的空配置（`plugins: {}`、只有注释、空文件）
 * 和"文件坏了"解析出来都是 `{}`。以前 setPluginConfig 用"有内容但零条目"
 * 来猜损坏 —— 全新安装的模板恰好就是 `plugins: {}`，于是**每个插件第一次
 * 保存配置必然报「解析失败」**（实测）。这个 400 还会被前端显示成"配置坏了"，
 * 用户完全不知道该怎么办。
 */
export function readPluginSettings(file: string): { ok: boolean; settings: PluginSettings } {
  const empty = { ok: true, settings: {} as PluginSettings }
  try {
    if (!existsSync(file)) return empty
    const raw = readFileSync(file, 'utf8')
    // 空文件 / 只有注释：YAML 解析出来是 null，属于合法空配置
    if (!raw.trim()) return empty
    const parsed = parseYaml(raw) as unknown
    if (parsed === null) return empty
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, settings: {} }
    const container = parsed as Record<string, unknown>
    const plugins = container['plugins']
    if (plugins === undefined || plugins === null) return empty
    if (typeof plugins !== 'object' || Array.isArray(plugins)) return { ok: false, settings: {} }

    const out: PluginSettings = {}
    for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      const config = record['config']
      out[id] = {
        config:
          config !== null && typeof config === 'object' && !Array.isArray(config)
            ? (config as PluginConfig)
            : {},
      }
    }
    return { ok: true, settings: out }
  } catch {
    // 真解析不了（YAML 语法错）：这才是"文件坏了"
    return { ok: false, settings: {} }
  }
}

/** 读配置。文件不存在 / 坏了都返回空对象，不让控制台起不来 */
export function loadPluginSettings(file: string): PluginSettings {
  return readPluginSettings(file).settings
}

/** 整个写回（保留其它插件的配置） */
export function savePluginSettings(file: string, settings: PluginSettings): void {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const body = stringifyYaml({ plugins: settings })
  writeFileSync(file, HEADER + body, 'utf8')
}

/** 取某个插件的配置（没有就是空对象） */
export function getPluginConfig(file: string, id: string): PluginConfig {
  return loadPluginSettings(file)[id]?.config ?? {}
}

/**
 * 改某个插件的配置（整体替换）。
 *
 * ⚠️ 必须先确认文件能解析：`loadPluginSettings` 解析失败会返回 `{}`，
 * 直接写回等于把 plugins.yaml 里**其它插件的配置全部清空**（没有任何备份）。
 * 所以这里先探一次 —— 解析不了就抛错，让调用方看到"配置文件坏了"，
 * 而不是静默把别人的配置删掉。
 */
export function setPluginConfig(file: string, id: string, config: PluginConfig): void {
  const { ok, settings: all } = readPluginSettings(file)
  // 只有**真解析失败**才拒绝；合法的空配置（`plugins: {}`）照常写。
  if (!ok) {
    throw new Error('plugins.yaml 解析失败（或结构不对），拒绝写入以免清空其它插件配置')
  }
  all[id] = { config }
  savePluginSettings(file, all)
}

/** 删掉某个插件的配置（卸载时调） */
export function removePluginConfig(file: string, id: string): boolean {
  const all = loadPluginSettings(file)
  if (!(id in all)) return false
  delete all[id]
  savePluginSettings(file, all)
  return true
}
