/**
 * 示例工具插件：注册一个 get_weather 工具。
 *
 * 宿主会把 ctx.registerTool 的工具挂进模型能调用的注册表；
 * 模型在对话里决定调用时，run(args) 返回一段文本交给它。
 */
export function activate(ctx) {
  ctx.log('天气插件已激活')

  ctx.registerTool({
    name: 'get_weather',
    description: '查某个城市现在的天气。想知道天气、或者用户问起天气时用。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，不填就用配置里的默认城市' },
      },
    },
    async run(args) {
      const city = String(args.city || ctx.config.city || '广州')
      // 示例不联网，返回固定文本；真插件在这里调 API
      return `${city}现在多云，24 度，湿度 70%。`
    },
  })
}

export function deactivate(ctx) {
  ctx.log('天气插件已卸载')
}