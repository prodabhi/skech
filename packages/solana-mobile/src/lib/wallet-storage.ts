import { isAddress } from '@solana/kit'
import * as SecureStore from 'expo-secure-store'
import { readJson, storage } from './storage'

export type SavedWallet = { address: string; authToken: string; cluster: string }
const LEGACY_KEY = 'skech:mwa'
const KEY = 'skech.mwa.v1'
const SIGNED_OUT = 'skech:mwa:signed-out'
let queue: Promise<unknown> = Promise.resolve()

/** Serialize restore, token rotation and sign-out so a late write cannot undo deletion. */
function ordered<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation)
  queue = result.catch(() => undefined)
  return result
}

function valid(value: unknown): value is SavedWallet {
  if (!value || typeof value !== 'object') return false
  const wallet = value as Partial<SavedWallet>
  return (
    typeof wallet.address === 'string' &&
    isAddress(wallet.address) &&
    typeof wallet.authToken === 'string' &&
    wallet.authToken.length > 0 &&
    typeof wallet.cluster === 'string'
  )
}

export function restoreWallet(cluster: string) {
  return ordered(async () => {
    if (storage.getBoolean(SIGNED_OUT)) return null
    const raw = await SecureStore.getItemAsync(KEY)
    const saved: unknown = raw ? JSON.parse(raw) : readJson<unknown>(LEGACY_KEY)
    if (!valid(saved)) {
      storage.delete(LEGACY_KEY)
      return null
    }
    // Delete the old plaintext copy only after the secure write succeeds.
    if (!raw)
      await SecureStore.setItemAsync(KEY, JSON.stringify(saved), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      })
    storage.delete(LEGACY_KEY)
    return saved.cluster === cluster ? saved : null
  })
}

export function persistWallet(wallet: SavedWallet) {
  return ordered(async () => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(wallet), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
    storage.delete(LEGACY_KEY)
    storage.delete(SIGNED_OUT)
  })
}

export function clearWallet() {
  storage.set(SIGNED_OUT, true)
  return ordered(async () => {
    storage.set(SIGNED_OUT, true)
    storage.delete(LEGACY_KEY)
    await SecureStore.deleteItemAsync(KEY)
  })
}
