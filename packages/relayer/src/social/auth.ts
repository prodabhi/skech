/**
 * A wallet's say-so for a change to the community: its profile, or whom it follows.
 *
 *   app → POST /challenge { player, action, payload }   checked, nothing kept
 *   service → { token, message }                        the message names the deployment, player, action, the
 *                                                        payload's hash, a nonce, and when it expires
 *   wallet signs the message (Ed25519, the wallet's own key)
 *   app → POST /<action> { token, payload, signature }  the same payload again
 *
 * The token is the challenge, sealed with a key only this process holds: asking for one keeps nothing, so asking
 * for many costs the service nothing. A signed challenge is taken once (its nonce kept until it expires), within five
 * minutes, for exactly the payload it was made for.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressEncoder, isAddress } from "@solana/kit";
import type { SocialAction } from "@skech/core/social";

export const CHALLENGE_MS = 300_000;
/** Signed challenges remembered at once: far more than the rate limits let through in five minutes. */
const MOST_USED = 100_000;

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
export const payloadHash = (payload: unknown) => createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
export const isPlayer = (value: unknown): value is string => typeof value === "string" && value.length <= 44 && isAddress(value);

/** The words the wallet signs. */
export function challengeMessage(c: { scope: string; player: string; action: SocialAction; hash: string; nonce: string; expires: number }) {
  return `skech social\nDeployment: ${c.scope}\nPlayer: ${c.player}\nAction: ${c.action}\nPayload: ${c.hash}\nNonce: ${c.nonce}\nExpires: ${new Date(c.expires).toISOString()}`;
}

export class Challenges {
  private used = new Map<string, number>();

  constructor(
    readonly scope: string,
    private readonly secret: Uint8Array = randomBytes(32),
    private readonly now: () => number = Date.now,
  ) {}

  private seal(body: string) {
    return createHmac("sha256", this.secret).update(body).digest();
  }

  issue(player: string, action: SocialAction, payload: unknown): { token: string; message: string } {
    const nonce = randomBytes(16).toString("hex");
    const expires = this.now() + CHALLENGE_MS;
    const hash = payloadHash(payload);
    const body = b64url(Buffer.from(JSON.stringify([player, action, hash, nonce, expires])));
    return { token: `${body}.${b64url(this.seal(body))}`, message: challengeMessage({ scope: this.scope, player, action, hash, nonce, expires }) };
  }

  /** Who signed, for which action: or throws with why not. Taking it uses it up. */
  take(token: unknown, payload: unknown, signature: unknown): { player: string; action: SocialAction } {
    if (typeof token !== "string" || token.length > 600 || typeof signature !== "string") throw new Unauthorized("Please sign again");
    const [body, mac, extra] = token.split(".");
    if (!body || !mac || extra !== undefined) throw new Unauthorized("Please sign again");
    const want = this.seal(body), got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Unauthorized("Please sign again");
    const sealed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown[];
    // A ticket is sealed with the same key: its shape is not a challenge's.
    if (!Array.isArray(sealed) || sealed.length !== 5 || typeof sealed[4] !== "number") throw new Unauthorized("Please sign again");
    const [player, action, hash, nonce, expires] = sealed as [string, SocialAction, string, string, number];
    if (expires <= this.now()) throw new Unauthorized("That signature has expired: please sign again");
    if (payloadHash(payload) !== hash) throw new Unauthorized("Please sign again");
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Unauthorized("Please sign again");
    const message = new TextEncoder().encode(challengeMessage({ scope: this.scope, player, action, hash, nonce, expires }));
    const key = new Uint8Array(getAddressEncoder().encode(player as Parameters<ReturnType<typeof getAddressEncoder>["encode"]>[0]));
    let valid = false;
    try {
      valid = ed25519.verify(Buffer.from(signature, "base64"), message, key, { zip215: false });
    } catch {
      valid = false;
    }
    if (!valid) throw new Unauthorized("Signature does not match your wallet");
    // Checked and kept with nothing awaited between: the same signature sent twice at once is taken once.
    if (this.used.has(nonce)) throw new Unauthorized("Already done: please sign again");
    if (this.used.size >= MOST_USED) this.prune();
    if (this.used.size >= MOST_USED) throw new Error("Try again in a moment");
    this.used.set(nonce, expires);
    return { player, action };
  }

  /**
   * A day's pass for a socket to send a player's live pen, given once its wallet signed a "pen" challenge: binding
   * again with it needs no signature. Good only with this process's key.
   */
  ticket(player: string, ms = 86_400_000): string {
    const body = b64url(Buffer.from(JSON.stringify(["pen", player, this.now() + ms])));
    return `${body}.${b64url(this.seal(body))}`;
  }
  /** The player a ticket is for, or null. */
  ticketPlayer(ticket: unknown): string | null {
    if (typeof ticket !== "string" || ticket.length > 300) return null;
    const [body, mac, extra] = ticket.split(".");
    if (!body || !mac || extra !== undefined) return null;
    const want = this.seal(body), got = Buffer.from(mac, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const [kind, player, expires] = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as [string, string, number];
    return kind === "pen" && expires > this.now() && isPlayer(player) ? player : null;
  }

  /** Forget nonces past their expiry: they could not be taken again anyway. */
  prune() {
    const now = this.now();
    for (const [nonce, expires] of this.used) if (expires <= now) this.used.delete(nonce);
  }

  get remembered() {
    return this.used.size;
  }
}

export class Unauthorized extends Error {}
