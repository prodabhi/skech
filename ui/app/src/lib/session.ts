"use client";

import { getAddressDecoder } from "@solana/kit";

/**
 * The session key: an Ed25519 key the browser makes and keeps, and will sign
 * with but never hand over. It lives in IndexedDB as a non-extractable
 * CryptoKey, so nothing on the page, not even this code, can read it out.
 * The game registers its public half against the player's wallet once, and
 * from then on every piece of ink is signed here, with no prompt. It can
 * place pieces, up to the allowance the wallet set, and never withdraw.
 *
 * Solana checks Ed25519 natively: the program's precompile verifies the
 * signature over the piece exactly as it sits in the transaction, as on the
 * phone (packages/solana-mobile/src/lib/session.ts).
 *
 * A browser whose WebCrypto has no Ed25519 (Chrome before 137, Samsung
 * Internet) gets the same key made in JavaScript, its secret in the same
 * store: readable by the page, which is the price of playing there at all.
 */

const DB = "skech";
const STORE = "keys";
const NAME = "session:ed25519";
/** The Monad game's key, from before: nothing checks it any more. */
const OLD = "session:p256";

export type SessionKey = {
  /** Its public half, base58, as the game records it. */
  address: string;
  /** An Ed25519 signature over `message`, 64 bytes. */
  sign: (message: Uint8Array) => Promise<Uint8Array>;
};

type Stored = CryptoKeyPair | { secret: Uint8Array };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const base58 = (publicKey: Uint8Array) => getAddressDecoder().decode(publicKey);

async function wrap(stored: Stored): Promise<SessionKey> {
  if ("secret" in stored) {
    const { ed25519 } = await import("@noble/curves/ed25519");
    return { address: base58(ed25519.getPublicKey(stored.secret)), sign: async (message) => ed25519.sign(message, stored.secret) };
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", stored.publicKey));
  if (raw.length !== 32) throw new Error("Not an Ed25519 public key");
  return { address: base58(raw), sign: async (message) => new Uint8Array(await crypto.subtle.sign("Ed25519", stored.privateKey, new Uint8Array(message))) };
}

/** A new key: WebCrypto's where it can, else one made in JavaScript. */
async function make(): Promise<Stored> {
  try {
    return (await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
  } catch {
    const { ed25519 } = await import("@noble/curves/ed25519");
    return { secret: ed25519.utils.randomSecretKey() };
  }
}

/** Whether this browser can hold a session key at all. */
export const canHoldSession = () => typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;

let cached: Promise<SessionKey> | null = null;

/** The browser's session key, made on first use. */
export function sessionKey(): Promise<SessionKey> {
  cached ??= (async () => {
    const db = await open();
    try {
      let stored = (await tx<Stored | undefined>(db, "readonly", (s) => s.get(NAME))) ?? null;
      if (!stored) {
        stored = await make();
        await tx(db, "readwrite", (s) => s.put(stored, NAME));
        await tx(db, "readwrite", (s) => s.delete(OLD)).catch(() => undefined);
      }
      return await wrap(stored);
    } finally {
      db.close();
    }
  })();
  cached.catch(() => (cached = null));
  return cached;
}

/** Throw the key away: the next visit makes a new one, which needs registering again. */
export async function forgetSessionKey() {
  cached = null;
  const db = await open();
  await tx(db, "readwrite", (s) => s.delete(NAME));
  db.close();
}
