/*
 * 插件安装器：只负责本地文件操作，不做任何网络请求。
 * 所有失败都通过返回值报告，不向调用方抛异常。
 */
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { compareVersions, parseManifest } from './manifest.ts'
import { scanPlugins } from './registry.ts'

/** 把任意异常转成可读文本，避免调用方拿到非字符串 */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 插件 id 只允许清单规则里的小写字母、数字和连字符，防止拼出越界路径 */
function isSafeId(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id)
}

/** 读宿主版本号：拿 package.json 的 version 去比清单里的 minHostVersion */
async function readHostVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 安装期间写进目标目录的记录文件 */
type InstallRecord = {
  id: string
  version: string
  installedAt: string
  source: string
}

/**
 * 从本地目录安装插件。
 * source 必须是已解压的插件目录，不能是 .zip 压缩包。
 */
export async function installPlugin(options: {
  source: string
  pluginsRoot: string
  allowOverwrite?: boolean
  /** 宿主的版本号，用来比对清单里的 minHostVersion。不传就从 package.json 读 */
  hostVersion?: string
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const sourcePath = resolve(options.source)
  const pluginsRoot = resolve(options.pluginsRoot)

  try {
    // 先按扩展名拦截压缩包，避免把 .zip 当目录去读
    if (extname(sourcePath).toLowerCase() === '.zip') {
      return {
        ok: false,
        error: `不支持的源类型：.zip 压缩包，请先解压为本地插件目录（${sourcePath}）`,
      }
    }

    let sourceStat
    try {
      sourceStat = await stat(sourcePath)
    } catch {
      return { ok: false, error: `源路径不存在：${sourcePath}` }
    }

    if (!sourceStat.isDirectory()) {
      return { ok: false, error: `不支持的源类型：请提供本地插件目录（${sourcePath}）` }
    }

    // 1. 读取并校验源目录里的 plugin.json
    const manifestPath = join(sourcePath, 'plugin.json')
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (err) {
      return { ok: false, error: `读取或解析 plugin.json 失败：${errorMessage(err)}` }
    }

    const parsed = parseManifest(raw)
    if (!parsed.ok) {
      return { ok: false, error: `插件清单校验失败：${parsed.errors.join('; ')}` }
    }
    const manifest = parsed.manifest

    // 2. 入口文件必须真的存在。
    // 不查的话会装进一个永远加载不起来的插件（list 里看得见、loaded 永远 false），
    // 用户根本不知道哪错了 —— 不如现在就说清楚。
    const entryPath = join(sourcePath, manifest.entry)
    if (!existsSync(entryPath)) {
      return {
        ok: false,
        error: `入口文件不存在：${manifest.entry}（清单里的 entry 要指向目录内真实存在的文件）`,
      }
    }

    // 3. 宿主版本要求
    if (manifest.minHostVersion) {
      const hostVersion = options.hostVersion ?? (await readHostVersion())
      if (compareVersions(hostVersion, manifest.minHostVersion) < 0) {
        return {
          ok: false,
          error: `这个插件要求宿主版本 >= ${manifest.minHostVersion}，当前是 ${hostVersion}`,
        }
      }
    }

    // 4. 目标目录已存在且未允许覆盖时，直接拒绝
    const targetDir = join(pluginsRoot, manifest.id)
    if (existsSync(targetDir) && options.allowOverwrite !== true) {
      return { ok: false, error: 'already installed' }
    }

    await mkdir(pluginsRoot, { recursive: true })

    // 覆盖安装时先清空旧目录，避免上一版本的文件残留
    if (existsSync(targetDir)) {
      await rm(targetDir, { recursive: true, force: true })
    }

    // 3. 递归复制插件目录
    try {
      await cp(sourcePath, targetDir, { recursive: true, force: true })
    } catch (err) {
      // 复制中途失败时清掉半成品，不给后续扫描留下坏目录
      await rm(targetDir, { recursive: true, force: true }).catch(() => undefined)
      return { ok: false, error: `复制插件文件失败：${errorMessage(err)}` }
    }

    // 4. 写入安装记录，source 用绝对路径，便于排查来源
    const record: InstallRecord = {
      id: manifest.id,
      version: manifest.version,
      installedAt: new Date().toISOString(),
      source: sourcePath,
    }
    try {
      await writeFile(
        join(targetDir, '.install.json'),
        `${JSON.stringify(record, null, 2)}\n`,
        'utf8',
      )
    } catch (err) {
      return { ok: false, error: `写入 .install.json 失败：${errorMessage(err)}` }
    }

    return { ok: true, id: manifest.id }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/**
 * 卸载插件：删除插件目录；purgeData 为 true 且提供 dataRoot 时一并删除插件数据目录。
 */
export async function uninstallPlugin(options: {
  id: string
  pluginsRoot: string
  dataRoot?: string
  purgeData?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeId(options.id)) return { ok: false, error: '非法的插件 id' }

  const pluginsRoot = resolve(options.pluginsRoot)
  const targetDir = join(pluginsRoot, options.id)

  try {
    if (!existsSync(targetDir)) return { ok: false, error: 'not installed' }

    await rm(targetDir, { recursive: true, force: true })

    // 只有显式要求清理且确实传了数据根目录时才动数据
    if (options.purgeData === true && typeof options.dataRoot === 'string' && options.dataRoot.length > 0) {
      await rm(join(resolve(options.dataRoot), 'plugins', options.id), {
        recursive: true,
        force: true,
      })
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/**
 * 启用或禁用插件：禁用时在插件目录写入空文件 disabled，启用时删除它。
 */
export async function setEnabled(options: {
  id: string
  pluginsRoot: string
  enabled: boolean
}): Promise<{ ok: boolean; error?: string }> {
  if (!isSafeId(options.id)) return { ok: false, error: '非法的插件 id' }

  const pluginDir = join(resolve(options.pluginsRoot), options.id)
  const marker = join(pluginDir, 'disabled')

  try {
    if (!existsSync(pluginDir)) return { ok: false, error: 'not installed' }

    if (options.enabled) {
      // 文件不存在时 rm + force 也不会报错
      await rm(marker, { force: true })
    } else {
      await writeFile(marker, '', 'utf8')
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/** checkUpdates 返回的单条结果 */
type UpdateItem = {
  id: string
  current: string
  latest?: string
  hasUpdate: boolean
  error?: string
}

/**
 * 检查已安装插件是否有更新。
 * 索引文件缺失或格式非法时不抛错，而是给每个插件条目附上 error。
 */
export async function checkUpdates(options: {
  pluginsRoot: string
  indexFile?: string
}): Promise<{ items: UpdateItem[]; error?: string }> {
  const pluginsRoot = resolve(options.pluginsRoot)
  const indexFile = resolve(options.indexFile ?? join(pluginsRoot, 'index.json'))

  try {
    const { plugins } = await scanPlugins(pluginsRoot)

    // 先尝试读取索引；任何读取或解析问题都记为统一错误
    let indexError: string | undefined
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(indexFile, 'utf8'))
    } catch (err) {
      const msg = errorMessage(err)
      // ENOENT 是"还没建索引"，不是出错 —— 给一句人话，别甩 node 的报错
      indexError = msg.includes('ENOENT')
        ? '还没有 plugins/index.json。有这个文件才能对比版本；没有也不影响插件本身，只是检查不了更新。'
        : `plugins/index.json 解析失败：${msg}`
    }

    // 索引里 id -> version 的映射；非法条目直接跳过
    const latestVersions = new Map<string, string>()
    if (indexError === undefined) {
      const container = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined
      const list = container
        ? (container as Record<string, unknown>)['plugins']
        : undefined

      if (!Array.isArray(list)) {
        indexError = '索引格式非法：缺少 plugins 数组'
      } else {
        for (const entry of list) {
          if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
          const record = entry as Record<string, unknown>
          const id = record['id']
          const version = record['version']
          if (typeof id === 'string' && typeof version === 'string') {
            latestVersions.set(id, version)
          }
        }
      }
    }

    const items: UpdateItem[] = plugins.map((plugin) => {
      const id = plugin.manifest.id
      const current = plugin.manifest.version
      const item: UpdateItem = { id, current, hasUpdate: false }

      // 索引不可用时，每个已安装插件都带上同一个错误，方便界面统一提示
      if (indexError !== undefined) {
        item.error = indexError
        return item
      }

      const latest = latestVersions.get(id)
      // 索引里没有的已安装插件视为没有更新信息，保持 hasUpdate 为 false
      if (latest === undefined) return item

      item.latest = latest
      try {
        item.hasUpdate = compareVersions(current, latest) < 0
      } catch (err) {
        // 索引里的版本号不合法时只影响当前条目，不影响其它插件
        item.hasUpdate = false
        item.error = `版本号比较失败：${errorMessage(err)}`
      }

      return item
    })

    if (indexError !== undefined) return { items, error: indexError }
    return { items }
  } catch (err) {
    // scanPlugins 本身不抛错，这里只是兜底，确保调用方永远拿到对象
    return { items: [], error: errorMessage(err) }
  }
}
