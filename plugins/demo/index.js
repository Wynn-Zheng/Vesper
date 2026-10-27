/**
 * 最小插件示例。
 *
 * 约定（照着写就行）：
 *   - 导出 activate(ctx)，可选的 deactivate(ctx)
 *   - ctx 由宿主注入：{ id, dataDir, log, on, emit }
 *   - 加载失败只影响这一个插件，不会把别的带崩
 *
 * 注意：外部插件是**任意 JS**，能读写你的文件和密钥。装之前确认来源可信。
 */

export function activate(ctx) {
  ctx.log(`示例插件已激活，数据目录：${ctx.dataDir}`)
}

export function deactivate(ctx) {
  ctx.log('示例插件已卸载')
}
