import { afterEach, describe, expect, test } from 'bun:test'
import { RelayerClient } from '../src/lib/relayer'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  sent: Record<string, unknown>[] = []
  constructor() {
    Socket.instances.push(this)
  }
  send(value: string) {
    this.sent.push(JSON.parse(value))
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: '' })
  }
  open() {
    this.readyState = Socket.OPEN
    this.onopen?.()
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }
}
const originalSocket = globalThis.WebSocket
globalThis.WebSocket = Socket as unknown as typeof WebSocket
const clients: RelayerClient[] = []
const client = (helloTimeoutMs = 8000) => {
  const c = new RelayerClient('wss://example.invalid', helloTimeoutMs)
  clients.push(c)
  c.start()
  return c
}
afterEach(() => {
  clients.splice(0).forEach((c) => c.stop())
  Socket.instances = []
})
process.on('exit', () => {
  globalThis.WebSocket = originalSocket
})

describe('relayer lifecycle', () => {
  test('an open socket without a hello is closed for retry', async () => {
    const c = client(20)
    const socket = Socket.instances[0]
    socket.open()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(socket.readyState).toBe(3)
    expect(c.connected).toBe(false)
  })

  test('a server hello cancels the connection deadline', async () => {
    const c = client(20)
    const socket = Socket.instances[0]
    socket.open()
    socket.message({ type: 'hello', cluster: 'devnet' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(socket.readyState).toBe(Socket.OPEN)
    expect(c.connected).toBe(true)
  })

  test('start is idempotent and stop releases outstanding requests', async () => {
    const c = client()
    c.start()
    expect(Socket.instances).toHaveLength(1)
    const socket = Socket.instances[0]
    socket.open()
    const pending = c.request(
      { type: 'account' },
      (m): m is Extract<typeof m, { type: 'account' }> => m.type === 'account',
    )
    c.stop()
    expect(await pending).toBeNull()
    expect(c.connected).toBe(false)
    expect(socket.readyState).toBe(3)
    expect(socket.onmessage).toBeNull()
  })

  test('stop clears an already scheduled reconnect', async () => {
    const c = client()
    Socket.instances[0].close()
    c.stop()
    await new Promise((resolve) => setTimeout(resolve, 550))
    expect(Socket.instances).toHaveLength(1)
  })

  test('overlapping wallet transactions cannot consume the same build', async () => {
    const c = client(),
      socket = Socket.instances[0]
    socket.open()
    c.watch('player-a')
    let signs = 0
    const first = c.transact('deposit', { amount: '1000000' }, async (tx) => {
      signs++
      return tx
    })
    const second = await c.transact('deposit', { amount: '2000000' }, async (tx) => {
      signs++
      return tx
    })
    expect(second.ok).toBe(false)
    expect(socket.sent.filter((m) => m.type === 'build')).toHaveLength(1)
    socket.message({ type: 'built', kind: 'deposit', id: 'build-1', tx: 'unsigned' })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    socket.message({ type: 'submitted', id: 'build-1', ok: true, tx: 'signature' })
    expect(await first).toEqual({ ok: true, tx: 'signature' })
    expect(signs).toBe(1)
  })

  test('an account switch while the wallet signs prevents submission', async () => {
    const c = client(),
      socket = Socket.instances[0]
    socket.open()
    c.watch('player-a')
    const result = c.transact('withdraw', {}, async (tx) => {
      c.watch('player-b')
      return tx
    })
    socket.message({ type: 'built', kind: 'withdraw', id: 'build-1', tx: 'unsigned' })
    expect((await result).ok).toBe(false)
    expect(socket.sent.some((m) => m.type === 'submit')).toBe(false)
  })
})
