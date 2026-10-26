/**
 * 假通道：在终端里模拟 QQ（OneBot 事件格式与真通道一致）。
 * 只实现 Transport 的 4 个方法，不含任何业务逻辑——业务在 src/boot.ts。
 * 以后可在这里加故障注入：断线、重复 message_id、慢响应、畸形消息。
 */
import { createInterface } from 'node:readline'
import { boot } from '../src/boot.ts'
import { loadRules } from '../src/core/config.ts'
import { info, initLog, warn } from '../src/core/log.ts'
import { setMemoryRoot } from '../src/memory/store.ts'
import { setPeopleRoot } from '../src/people/store.ts'
import type { Transport } from '../src/core/transport.ts'
import type { Incoming, Target } from '../src/core/types.ts'

class MockTransport implements Transport {
  readonly kind = 'mock'
  private handler: ((m: Incoming) => void) | null = null
  private rl: ReturnType<typeof createInterface> | null = null
  private seq = 0
  readonly me: Target = { kind: 'private', id: '10000', name: '我' }
  readonly peer: Target = { kind: 'private', id: '20000', name: '测试者' }

  onMessage(fn: (m: Incoming) => void): void {
    this.handler = fn
  }

  async start(): Promise<void> {
    this.rl = createInterface({ input: process.stdin, output: process.stdout })
    this.rl.setPrompt('> ')
    this.rl.prompt()

    this.rl.on('line', (line) => {
      const text = line.trim()
      if (text === '/quit' || text === '/exit') {
        info('退出中，等未完成的回复发完…')
        setTimeout(() => process.exit(0), 7000)
        return
      }
      if (text) this.emit(text)
      this.rl?.prompt()
    })

    // 标准输入结束（管道 / Ctrl+D）时也留时间给回复
    this.rl.on('close', () => setTimeout(() => process.exit(0), 7000))

    info('假通道已就绪：输入文字回车发送，/quit 退出')
  }

  async stop(): Promise<void> {
    this.rl?.close()
    this.rl = null
  }

  private msgSeq = 0

  async send(to: Target, text: string): Promise<{ messageId?: string }> {
    void to
    // 模拟发送耗时，便于观察条间延迟
    await new Promise((r) => setTimeout(r, 30))
    this.msgSeq += 1
    console.log(`\x1b[32m← [它] ${text}\x1b[0m`)
    return { messageId: `mock-msg-${this.msgSeq}` }
  }

  async recall(messageId: string): Promise<boolean> {
    console.log(`\x1b[33m[撤回] ${messageId}\x1b[0m`)
    return true
  }

  private emit(text: string): void {
    this.seq += 1
    this.handler?.({
      id: `mock-${this.seq}`,
      from: this.peer,
      selfId: this.me.id,
      text,
      at: Date.now(),
    })
  }
}

initLog()
// 假通道的数据写到独立目录，绝不污染 persona/
setMemoryRoot('.dev-memory')
setPeopleRoot('.dev-people')
const { rules, warnings } = loadRules()
for (const w of warnings) warn(w)

const transport = new MockTransport()
boot(transport, { getRules: () => rules, reply: (m) => m.text })
await transport.start()
