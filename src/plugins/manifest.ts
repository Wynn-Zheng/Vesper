/**
 * 插件清单 plugin.json 的类型与校验。
 * 这里只做纯数据校验，不读文件；任何非法输入都通过 errors 返回，不抛异常。
 */
import { isAbsolute } from 'node:path'

export type PluginManifest = {
  id: string
  name: string
  version: string
  entry: string
  description?: string
  author?: string
  permissions?: string[]
  minHostVersion?: string
  /** 配置项声明。有它 → 控制台按类型渲染表单项；没有 → 退化成键值编辑器 */
  configSchema?: PluginConfigSchema
}

/** 配置项能用的控件类型 */
export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'select'

/**
 * 一个配置项的声明。
 *
 * 参考 VS Code 的 configuration 贡献点：插件说清"有哪些项、什么类型、默认值多少"，
 * 宿主照着渲染，用户就不会填出 `间隔秒数: "abc"` 这种。
 */
export type ConfigField = {
  type: ConfigFieldType
  /** 显示用的名字，不填就用键名 */
  label?: string
  /** 默认值，插件自己定 */
  default?: unknown
  /** 一行说明，显示在控件下面 */
  hint?: string
  /** type=number 时有效 */
  min?: number
  max?: number
  /** type=select 时有效，必须非空 */
  options?: string[]
}

export type PluginConfigSchema = Record<string, ConfigField>

/** 合法的控件类型，校验和前端都用它 */
export const CONFIG_FIELD_TYPES: ConfigFieldType[] = ['string', 'number', 'boolean', 'select']

/** id：只允许小写字母、数字和连字符 */
const ID_RE = /^[a-z0-9-]+$/
/** 三段数字版本，允许 -prerelease 后缀，不支持 +build */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === 'string')
}

/** entry 必须是相对路径，不含 '..'，且以 .js/.mjs/.ts/.cjs 结尾 */
function isRelativeEntry(entry: string): boolean {
  // 扩展名前至少要有一个字符，避免出现 ".js" 这种没有文件名的路径
  if (!/^.+\.(?:js|mjs|ts|cjs)$/.test(entry)) return false
  // 绝对路径（含 Windows 盘符、UNC）一律拒绝
  if (isAbsolute(entry)) return false
  if (/^[A-Za-z]:/.test(entry)) return false
  // 逐段检查，禁止 '..' 逃出插件目录
  const segments = entry.split(/[\\/]+/)
  return !segments.includes('..')
}

/**
 * 校验原始 JSON 数据。
 * 缺字段、类型错误会逐条写进 errors；绝不抛异常。
 */
export function parseManifest(
  raw: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['清单必须是一个 JSON 对象'] }
  }

  const errors: string[] = []

  const id = raw['id']
  if (id === undefined) errors.push('缺少字段 id')
  else if (typeof id !== 'string') errors.push('字段 id 必须是字符串')
  else if (id.length < 1 || id.length > 64) errors.push('字段 id 长度必须在 1..64 之间')
  else if (!ID_RE.test(id)) errors.push("字段 id 只允许小写字母、数字和 '-'")

  const name = raw['name']
  if (name === undefined) errors.push('缺少字段 name')
  else if (typeof name !== 'string') errors.push('字段 name 必须是字符串')
  else if (name.trim().length === 0) errors.push('字段 name 不能为空')

  const version = raw['version']
  if (version === undefined) errors.push('缺少字段 version')
  else if (typeof version !== 'string') errors.push('字段 version 必须是字符串')
  else if (!VERSION_RE.test(version)) errors.push('字段 version 必须形如 x.y.z 或 x.y.z-prerelease')

  const entry = raw['entry']
  if (entry === undefined) errors.push('缺少字段 entry')
  else if (typeof entry !== 'string') errors.push('字段 entry 必须是字符串')
  else if (!isRelativeEntry(entry)) errors.push("字段 entry 必须是相对路径、不含 '..'、以 .js/.mjs/.ts/.cjs 结尾")

  // 可选字段：缺省可以，出现了就必须是正确类型
  for (const key of ['description', 'author', 'minHostVersion'] as const) {
    const value = raw[key]
    if (value !== undefined && typeof value !== 'string') errors.push(`字段 ${key} 必须是字符串`)
  }

  const permissions = raw['permissions']
  if (permissions !== undefined && !isStringArray(permissions)) {
    errors.push('字段 permissions 必须是字符串数组')
  }

  // 配置项声明：可选，出现了就必须挑得出毛病
  const configSchema = raw['configSchema']
  if (configSchema !== undefined) {
    if (!isPlainObject(configSchema)) {
      errors.push('字段 configSchema 必须是对象')
    } else {
      for (const [fieldKey, field] of Object.entries(configSchema)) {
        if (!isPlainObject(field)) {
          errors.push(`configSchema.${fieldKey} 必须是一个对象`)
          continue
        }
        const fieldType = field['type']
        if (typeof fieldType !== 'string' || !CONFIG_FIELD_TYPES.includes(fieldType as ConfigFieldType)) {
          errors.push(
            `configSchema.${fieldKey}.type 只能是 ${CONFIG_FIELD_TYPES.join(' / ')}，现在是 ${JSON.stringify(fieldType)}`,
          )
          continue
        }
        if (fieldType === 'select') {
          const opts = field['options']
          if (!isStringArray(opts) || opts.length === 0) {
            errors.push(`configSchema.${fieldKey} 是 select，必须带一个非空的 options 字符串数组`)
          }
        }
        for (const numKey of ['min', 'max'] as const) {
          const nv = field[numKey]
          if (nv !== undefined && typeof nv !== 'number') {
            errors.push(`configSchema.${fieldKey}.${numKey} 必须是数字`)
          }
        }
        for (const strKey of ['label', 'hint'] as const) {
          const sv = field[strKey]
          if (sv !== undefined && typeof sv !== 'string') {
            errors.push(`configSchema.${fieldKey}.${strKey} 必须是字符串`)
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // 必填字段已在上面逐一确认过类型，这里再收窄一次给类型检查器看
  if (
    typeof id !== 'string' ||
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    typeof entry !== 'string'
  ) {
    return { ok: false, errors: ['清单字段类型不正确'] }
  }

  const manifest: PluginManifest = { id, name, version, entry }
  if (typeof raw['description'] === 'string') manifest.description = raw['description']
  if (typeof raw['author'] === 'string') manifest.author = raw['author']
  if (typeof raw['minHostVersion'] === 'string') manifest.minHostVersion = raw['minHostVersion']
  if (isStringArray(permissions)) manifest.permissions = permissions
  // 上面已经逐项校验过，这里直接收窄（校验不过不会走到这）
  if (isPlainObject(configSchema)) manifest.configSchema = configSchema as PluginConfigSchema

  return { ok: true, manifest }
}

/** 取出版本号的三段数字；不是合法版本时返回 null */
function coreParts(version: string): [string, string, string] | null {
  if (!VERSION_RE.test(version)) return null
  const core = version.split('-')[0]
  if (core === undefined) return null
  const parts = core.split('.')
  if (parts.length !== 3) return null
  return [parts[0]!, parts[1]!, parts[2]!]
}

/** 比较两段纯数字字符串，先比长度再逐位比，避免超出安全整数范围 */
function compareNumericStrings(a: string, b: string): number {
  const na = a.replace(/^0+(?=\d)/, '')
  const nb = b.replace(/^0+(?=\d)/, '')
  if (na.length !== nb.length) return na.length < nb.length ? -1 : 1
  if (na === nb) return 0
  return na < nb ? -1 : 1
}

/**
 * 只比较三段数字，返回 -1 / 0 / 1。
 * 预发布后缀（如 -beta）不参与比较；非法版本抛 Error，由调用方自行捕获。
 */
export function compareVersions(a: string, b: string): number {
  const pa = coreParts(a)
  const pb = coreParts(b)
  if (!pa || !pb) throw new Error(`非法版本号：${!pa ? a : b}`)

  for (let i = 0; i < 3; i++) {
    const result = compareNumericStrings(pa[i]!, pb[i]!)
    if (result !== 0) return result
  }
  return 0
}
