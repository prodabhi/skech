"use client";

import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * The browser's gasless drawing key. It is a non-extractable P-256 key kept
 * in IndexedDB; the EVM game records its public coordinates and accepts only
 * piece signatures from it. It can stake up to the wallet-approved allowance
 * but can never withdraw.
 *
 * WebCrypto signs SHA-256(digest). SkechGame mirrors that for P-256 sessions
 * before calling OpenZeppelin's verifier, so the signature is chain-portable
 * and does not depend on an Arc-specific precompile.
 */

const DB = "skech";
const STORE = "keys";
const NAME = "session:p256";
const OLD = "session:ed25519";
/** P-256's order, used to normalize signatures to low-s. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export type SessionKey = {
  x: Hex;
  y: Hex;
  /** r || s, 64 bytes, low-s. */
  sign: (digest: Hex) => Promise<Hex>;
};

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

async function wrap(pair: CryptoKeyPair): Promise<SessionKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Not a P-256 public key");
  return {
    x: bytesToHex(raw.slice(1, 33)),
    y: bytesToHex(raw.slice(33, 65)),
    sign: async (digest) => {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(hexToBytes(digest))));
      const r = sig.slice(0, 32);
      let s = BigInt(bytesToHex(sig.slice(32, 64)));
      if (s > N / 2n) s = N - s;
      return bytesToHex(new Uint8Array([...r, ...hexToBytes(`0x${s.toString(16).padStart(64, "0")}`)]));
    },
  };
}

export const canHoldSession = () => typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && !!crypto.subtle;

let cached: Promise<SessionKey> | null = null;

/** The browser's session key, made on first use. */
export function sessionKey(): Promise<SessionKey> {
  cached ??= (async () => {
    const db = await open();
    try {
      let pair = (await tx<CryptoKeyPair | undefined>(db, "readonly", (s) => s.get(NAME))) ?? null;
      if (!pair) {
        pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
        await tx(db, "readwrite", (s) => s.put(pair, NAME));
        await tx(db, "readwrite", (s) => s.delete(OLD)).catch(() => undefined);
      }
      return await wrap(pair);
    } finally {
      db.close();
    }
  })();
  cached.catch(() => (cached = null));
  return cached;
}

/** Throw the key away; the next visit creates one that must be registered. */
export async function forgetSessionKey() {
  cached = null;
  const db = await open();
  await tx(db, "readwrite", (s) => s.delete(NAME));
  db.close();
}
