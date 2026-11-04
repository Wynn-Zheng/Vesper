/**
 * 本机类工具：截图、窗口、剪贴板、鼠标键盘、发本地图片。
 *
 * 这些一律只允许「主人 + 私聊」发起。集合从 loop/chat.ts 挪到这里，
 * 是因为权限门现在放在 tools/registry.ts（所有工具调用的唯一入口），
 * 而 chat 反过来依赖 registry —— 放在两边会造成循环依赖。
 *
 * 新增本机工具必须往这里加一条。测试会断言「注册表里每个 desktop 工具都在集合里」。
 */
export const LOCAL_TOOLS = new Set([
  'screenshot', 'list_windows', 'monitor_info', 'mouse_position', 'clipboard_read',
  'click', 'type_text', 'press_key', 'scroll', 'focus_window',
  'send_image',
])

export function isLocalTool(name: string): boolean {
  return LOCAL_TOOLS.has(name)
}
