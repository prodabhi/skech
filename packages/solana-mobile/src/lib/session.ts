import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder } from "@solana/kit";
import * as SecureStore from "expo-secure-store";
import { platformSigner } from "../../modules/skech-ed25519/src";

/**
 * The session key: an Ed25519 key the app makes once and keeps in the phone's secure store (the Keychain on
 * iPhones, the Keystore-backed store on Android), readable by this app alone and only on this device. The game
 * registers its public half against the player's wallet once, and from then on every piece of ink is signed
 * here, with no prompt. It can place pieces, up to the allowance the wallet set, and never withdraw.
 *
 * It is Ed25519, which Solana checks natively: verified by the chain's precompile over the piece exactly as it sits
 * in the transaction.
 */

const NAME = "skech.session.ed25519";
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

export type SessionKey = {
  /** Its public half, base58, as the game records it. */
  address: string;
  /** An Ed25519 signature over `message`, 64 bytes. */
  sign: (message: Uint8Array) => Uint8Array;
};

let cached: SessionKey | null = null;
/** A key being read or made: two callers at startup share it, rather than each making (and saving) its own. */
let loading: Promise<SessionKey> | null = null;
/** A key being thrown away: asked for meanwhile, the answer is a fresh key, never the one going. */
let deleting: Promise<void> | null = null;

/** The phone's session key, made on first use. */
export async function sessionKey(): Promise<SessionKey> {
  if (deleting) await deleting;
  if (cached) return cached;
  if (loading) return loading;
  loading = loadKey();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

async function loadKey(): Promise<SessionKey> {
  let secret = await SecureStore.getItemAsync(NAME);
  if (!secret) {
    secret = hex(ed25519.utils.randomSecretKey());
    await SecureStore.setItemAsync(NAME, secret, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  const priv = unhex(secret);
  const address = getAddressDecoder().decode(ed25519.getPublicKey(priv));
  cached = { address, sign: nativeSigner(priv) ?? ((message) => ed25519.sign(message, priv)) };
  return cached;
}

/**
 * Every tap and every 150ms of a stroke signs a piece, on the JS thread. In JavaScript (noble, on Hermes's slow
 * BigInt) a signature takes 5-20ms on a cheap phone, a dropped frame each time; the platform's own Ed25519
 * (Android 13 and up) takes well under one. Ed25519 is deterministic, so it is used only once it gives noble's
 * signature byte for byte.
 */
function nativeSigner(priv: Uint8Array): ((message: Uint8Array) => Uint8Array) | null {
  try {
    const sign = platformSigner(priv);
    if (!sign) {
      console.info("[session] no platform Ed25519 here: signing in JS");
      return null;
    }
    const probe = new TextEncoder().encode("skech session key check");
    const native = sign(probe);
    const noble = ed25519.sign(probe, priv);
    if (native.length === 64 && native.every((b, i) => b === noble[i])) {
      console.info("[session] signing pieces natively");
      return sign;
    }
    console.warn("[session] native Ed25519 disagreed with noble: signing in JS");
  } catch (e) {
    console.warn("[session] no native Ed25519, signing in JS:", e);
  }
  return null;
}

/** Throw the key away: the next session needs registering again. */
export async function forgetSessionKey() {
  if (deleting) return deleting;
  deleting = (async () => {
    if (loading) await loading.catch(() => undefined);
    cached = null;
    await SecureStore.deleteItemAsync(NAME);
  })();
  try {
    await deleting;
  } finally {
    deleting = null;
  }
}
