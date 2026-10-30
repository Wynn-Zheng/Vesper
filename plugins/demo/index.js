/**
 * 最小插件示例。
 *
 * 约定（照着写就行）：
 *   - 导出 activate(ctx)，可选的 deactivate(ctx)
 *   - ctx 由宿主注入：{ id, dataDir, config, log, on, emit }
 *   - 加载失败只影响这一个插件，不会把别的带崩
 *
 * 配置在 persona/plugins.yaml 的 plugins.<id>.config 下，
 * 激活时读一次快照 —— 改完要重载插件才生效。
 *
 * 注意：外部插件是**任意 JS**，能读写你的文件和密钥。装之前确认来源可信。
 */

export function activate(ctx) {
  const keys = Object.keys(ctx.config ?? {})
  const summary = keys.length ? keys.join('、') : '（还没有配置）'
  ctx.log(`示例插件已激活；数据目录 ${ctx.dataDir}；配置项：${summary}`)
}

export function deactivate(ctx) {
  ctx.log('示例插件已卸载')
}
