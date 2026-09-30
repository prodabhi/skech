import { MMKV } from 'react-native-mmkv'

/**
 * What the web keeps in localStorage, kept on the phone: MMKV, synchronous like localStorage, so the stores
 * read the same way they do on the web, and fast enough to write on every change.
 */
export const storage = new MMKV({ id: 'skech' })

export function readJson<T>(key: string): T | null {
  try {
    const raw = storage.getString(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown) {
  try {
    storage.set(key, JSON.stringify(value))
  } catch {
    // Out of space: it still holds for this run.
  }
}
