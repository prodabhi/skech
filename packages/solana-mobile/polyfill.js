// What the wallet SDKs and the shared code expect of a JavaScript engine, before anything else loads.
import 'fast-text-encoding'
import 'react-native-get-random-values'
// Privy's documented set: normalize, atob/btoa and the like, each only where the engine lacks it.
import '@ethersproject/shims'
import structuredClone from '@ungap/structured-clone'
import { Buffer } from 'buffer'
import { sha1 } from '@noble/hashes/legacy'
import { sha256, sha384, sha512 } from '@noble/hashes/sha2'
import { randomUUID } from 'expo-crypto'

if (!('structuredClone' in globalThis)) globalThis.structuredClone = structuredClone
if (!('Buffer' in globalThis)) globalThis.Buffer = Buffer
// The two bits of WebCrypto Privy reaches for: SHA digests and random UUIDs. A whole native OpenSSL used to ship for this.
const DIGESTS = { 'SHA-1': sha1, 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 }
const bytes = (data) => (data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data))
const subtle = globalThis.crypto.subtle ?? {}
if (!subtle.digest) {
  subtle.digest = async (algorithm, data) => {
    const hash = DIGESTS[(typeof algorithm === 'string' ? algorithm : algorithm.name).toUpperCase()]
    if (!hash) throw new Error(`crypto.subtle.digest: ${algorithm} is not supported`)
    return hash(bytes(data)).slice().buffer
  }
  globalThis.crypto.subtle = subtle
}
if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = randomUUID
