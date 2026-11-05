/**
 * transport 类型插件的示例：一个「假通道」。
 *
 * 它不连任何真实平台，只把消息打到日志里 —— 目的是证明
 * 「平台接入」这件事是可以做成插件的，而不是只能硬编码在 channel 层。
 *
 * 宿主约定（这一版）：
 *   - 插件导出 `createTransport(ctx)` → 返回一个 Transport 对象
 *   - Transport 的形状和 src/core/transport.ts 里的接口一致
 *   - 真正接管消息仍需要重启（boot 只接一个通道，不做热插拔）
 *
 * 为什么不做热插拔：现在的 boot() 在启动时把 transport 固定住，
 * 中途换通道要做状态迁移（会话、正在处理的队列）。硬做很容易出
 * "换了一半"的状态，所以这一版明确要求重启。
 */

let ctxRef = null
/** onMessage 注册进来的回调；真通道在收到平台消息时调它 */
let onIncoming = null

/**
 * 造一个 Transport。
 *
 * 真实实现要：连平台 → 收到消息调 onIncoming → 发消息走 send。
 * 这里只留骨架，方便照着写。
 *
 * 形状必须和 src/core/transport.ts 的 Transport 一致：
 * kind / start / stop / onMessage / send（+ 可选的 connected、recall 等）。
 * 以前这里写的是 name 和 isReady()，两处都对不上，接上去也不认。
 */
export function createTransport(ctx) {
  ctxRef = ctx
  ctx.log('示例通道已创建（不会真的发消息）')

  return {
    /** 通道名，日志里用；接口里叫 kind */
    kind: 'demo-transport',

    /**
     * 发一条消息。真实实现里这里要调平台的 API。
     * 返回 { messageId }（能撤回就返回，拿不到就留空）。
     */
    async send(target, text) {
      ctx.log(`[示例通道] 假装发给 ${target.kind}:${target.id}：${String(text).slice(0, 40)}`)
      return { messageId: `demo-${Date.now()}` }
    },

    /** 启动通道（连平台）。返回后表示已就绪。 */
    async start() {
      ctx.log('示例通道已启动（没有真的连接）')
    },

    /** 停掉通道，释放连接 */
    async stop() {
      onIncoming = null
      ctx.log('示例通道已停止')
    },

    /** 宿主要求：把"收到消息时该调什么"交进来 */
    onMessage(fn) {
      onIncoming = fn
    },

    /** 通道是否连着（控制台会用这个显示状态） */
    get connected() {
      return Boolean(ctxRef?.config?.echo ?? true)
    },
  }
}

export function activate(ctx) {
  ctxRef = ctx
  ctx.log('示例通道插件已加载。它是 transport 类型，会出现在「接入平台」里。')
}

export function deactivate(ctx) {
  ctx.log('示例通道插件已卸载')
  ctxRef = null
}
