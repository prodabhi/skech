import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519";
import { getAddressDecoder } from "@solana/kit";
import { CHALLENGE_MS, Challenges, isPlayer, Unauthorized } from "./auth";

const wallet = () => {
  const secret = ed25519.utils.randomPrivateKey();
  const player = getAddressDecoder().decode(ed25519.getPublicKey(secret)) as string;
  const sign = (message: string) => Buffer.from(ed25519.sign(new TextEncoder().encode(message), secret)).toString("base64");
  return { player, sign };
};

describe("signed challenges", () => {
  const payload = { username: "pen", bio: "" };

  test("a challenge signed by the wallet it names is taken, once", () => {
    const c = new Challenges("solana-devnet:Game");
    const w = wallet();
    const { token, message } = c.issue(w.player, "profile", payload);
    expect(message).toContain(`Player: ${w.player}`);
    expect(message).toContain("Deployment: solana-devnet:Game");
    expect(c.take(token, payload, w.sign(message))).toEqual({ player: w.player, action: "profile" });
    // A replay of the same signature is refused.
    expect(() => c.take(token, payload, w.sign(message))).toThrow(Unauthorized);
  });

  test("another wallet's signature is refused, and does not use the challenge up", () => {
    const c = new Challenges("s");
    const w = wallet(), other = wallet();
    const { token, message } = c.issue(w.player, "follow", { target: other.player, enabled: true });
    expect(() => c.take(token, { target: other.player, enabled: true }, other.sign(message))).toThrow("Signature does not match your wallet");
    expect(c.take(token, { target: other.player, enabled: true }, w.sign(message)).player).toBe(w.player);
  });

  test("the payload signed for is the only one it is good for", () => {
    const c = new Challenges("s");
    const w = wallet();
    const { token, message } = c.issue(w.player, "profile", payload);
    expect(() => c.take(token, { username: "someone_else", bio: "" }, w.sign(message))).toThrow(Unauthorized);
  });

  test("a token changed or made elsewhere is refused", () => {
    const c = new Challenges("s"), elsewhere = new Challenges("s");
    const w = wallet();
    const { token, message } = elsewhere.issue(w.player, "profile", payload);
    expect(() => c.take(token, payload, w.sign(message))).toThrow(Unauthorized);
    const mine = c.issue(w.player, "profile", payload);
    const [body, mac] = mine.token.split(".");
    const forged = Buffer.from(JSON.stringify([wallet().player, ...JSON.parse(Buffer.from(body, "base64url").toString()).slice(1)])).toString("base64url");
    expect(() => c.take(`${forged}.${mac}`, payload, w.sign(mine.message))).toThrow(Unauthorized);
    expect(() => c.take("x.y.z", payload, w.sign(mine.message))).toThrow(Unauthorized);
    expect(() => c.take(mine.token, payload, "not a signature")).toThrow(Unauthorized);
  });

  test("a challenge expires after five minutes, and is forgotten once expired", () => {
    let now = 1_000_000;
    const c = new Challenges("s", undefined, () => now);
    const w = wallet();
    const late = c.issue(w.player, "profile", payload);
    now += CHALLENGE_MS + 1;
    expect(() => c.take(late.token, payload, w.sign(late.message))).toThrow("expired");
    const fresh = c.issue(w.player, "profile", payload);
    c.take(fresh.token, payload, w.sign(fresh.message));
    expect(c.remembered).toBe(1);
    now += CHALLENGE_MS + 1;
    c.prune();
    expect(c.remembered).toBe(0);
  });

  test("a live pen's ticket binds again for a day, and is no challenge", () => {
    let now = 1_000_000;
    const c = new Challenges("s", undefined, () => now);
    const w = wallet();
    const ticket = c.ticket(w.player);
    expect(c.ticketPlayer(ticket)).toBe(w.player);
    expect(c.ticketPlayer(new Challenges("s").ticket(w.player))).toBeNull();
    expect(c.ticketPlayer(`${ticket}x`)).toBeNull();
    // Sealed with the same key, a ticket still cannot pass for a signed challenge, nor a challenge for a ticket.
    expect(() => c.take(ticket, {}, w.sign("x"))).toThrow(Unauthorized);
    expect(c.ticketPlayer(c.issue(w.player, "pen", {}).token)).toBeNull();
    now += 86_400_001;
    expect(c.ticketPlayer(ticket)).toBeNull();
  });

  test("players are Solana addresses", () => {
    expect(isPlayer(wallet().player)).toBe(true);
    expect(isPlayer("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isPlayer("1".repeat(60))).toBe(false);
    expect(isPlayer(null)).toBe(false);
  });
});
