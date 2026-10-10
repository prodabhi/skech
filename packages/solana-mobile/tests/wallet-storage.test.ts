import { beforeEach, describe, expect, mock, test } from 'bun:test'

const secure = new Map<string, string>()
const plain = new Map<string, unknown>()
let failWrite = false,
  failDelete = false,
  writes = 0
mock.module('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (failWrite) throw new Error('Storage unavailable')
    writes++
    secure.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    if (failDelete) throw new Error('Storage unavailable')
    secure.delete(key)
  },
}))
mock.module('../src/lib/storage', () => ({
  readJson: (key: string) => plain.get(key) ?? null,
  storage: {
    delete: (key: string) => plain.delete(key),
    set: (key: string, value: unknown) => plain.set(key, value),
    getBoolean: (key: string) => plain.get(key),
  },
}))
// The platform's Ed25519 is a native module; here the session key signs with noble, as on a phone without it.
mock.module('../modules/skech-ed25519/src', () => ({ platformSigner: () => null }))
const { clearWallet, persistWallet, restoreWallet } = await import('../src/lib/wallet-storage')
const { sessionKey, forgetSessionKey } = await import('../src/lib/session')
const wallet = { address: '11111111111111111111111111111111', authToken: 'test-token', cluster: 'solana:devnet' }
beforeEach(async () => {
  failWrite = false
  failDelete = false
  await forgetSessionKey()
  secure.clear()
  plain.clear()
  writes = 0
})

describe('wallet credential storage', () => {
  test('migrates only after a successful secure write', async () => {
    plain.set('skech:mwa', wallet)
    failWrite = true
    await expect(restoreWallet(wallet.cluster)).rejects.toThrow()
    expect(plain.has('skech:mwa')).toBe(true)
    failWrite = false
    expect(await restoreWallet(wallet.cluster)).toEqual(wallet)
    expect(plain.has('skech:mwa')).toBe(false)
    expect(JSON.parse(secure.get('skech.mwa.v1')!)).toEqual(wallet)
  })

  test('sign-out wins over an in-flight token rotation', async () => {
    const write = persistWallet(wallet)
    const clear = clearWallet()
    await Promise.all([write, clear])
    expect(secure.size).toBe(0)
    expect(await restoreWallet(wallet.cluster)).toBeNull()
  })

  test('failed secure deletion cannot restore a signed-out wallet', async () => {
    await persistWallet(wallet)
    failDelete = true
    await expect(clearWallet()).rejects.toThrow()
    expect(await restoreWallet(wallet.cluster)).toBeNull()
  })

  test('legacy credentials from another cluster are still removed from plaintext', async () => {
    plain.set('skech:mwa', wallet)
    expect(await restoreWallet('solana:mainnet')).toBeNull()
    expect(plain.has('skech:mwa')).toBe(false)
    expect(secure.has('skech.mwa.v1')).toBe(true)
  })

  test('a wallet saved on another cluster is not reused', async () => {
    await persistWallet(wallet)
    expect(await restoreWallet('solana:mainnet')).toBeNull()
  })
})

describe('session key lifecycle', () => {
  test('concurrent startup callers share one persisted key', async () => {
    const [first, second] = await Promise.all([sessionKey(), sessionKey()])
    expect(first).toBe(second)
    expect(writes).toBe(1)
  })

  test('a key request during deletion waits for a fresh key', async () => {
    const old = await sessionKey()
    const deleting = forgetSessionKey()
    const creating = sessionKey()
    await deleting
    const fresh = await creating
    expect(fresh.address).not.toBe(old.address)
    expect(await sessionKey()).toBe(fresh)
  })
})
