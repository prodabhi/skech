import { describe, expect, test } from "bun:test";
import { activityRuns, type SocialActivity, applyFeed, avatarChoices, PEN_POINTS_PER_MESSAGE, penPack, penProblem, penUnpack, avatarSeedOf, avatarSeedProblem, BIO_MAX, cleanBio, EMPTY_FEED, LIVE_MS, looksLikePlayer, type PlayerProfile, playerHue, playerName, type PublicDrawing, remoteDrawings, socialMoney, socialSocketUrl, socialUrl, usernameProblem, visibleDrawings, windowStart } from "./social";

describe("social", () => {
  test("usernames: lowercase, 3 to 24, a letter first, nothing reserved", () => {
    expect(usernameProblem("ink_maker_7")).toBeNull();
    expect(usernameProblem("abc")).toBeNull();
    expect(usernameProblem("a".repeat(24))).toBeNull();
    for (const bad of ["ab", "a".repeat(25), "Ink", "7ink", "_ink", "ink-maker", "ink maker", "ïnk", "", null, 42]) expect(usernameProblem(bad)).not.toBeNull();
    expect(usernameProblem("admin")).toBe("That username is reserved");
    expect(usernameProblem("skech_official")).toBe("That username is reserved");
  });

  test("bios: trimmed, at most 160 characters and five lines, nothing hidden", () => {
    expect(cleanBio("  draws ahead  ")).toBe("draws ahead");
    expect(cleanBio("a\r\nb")).toBe("a\nb");
    expect(cleanBio("é".repeat(BIO_MAX))).toHaveLength(BIO_MAX);
    // Characters, not UTF-16 units: an emoji is one.
    expect(cleanBio("🖊".repeat(BIO_MAX))).toBe("🖊".repeat(BIO_MAX));
    expect(() => cleanBio("x".repeat(BIO_MAX + 1))).toThrow();
    expect(() => cleanBio("a\nb\nc\nd\ne\nf")).toThrow();
    for (const hidden of ["a‮b", "a​b", "a\u0000b", "a\tb"]) expect(() => cleanBio(hidden)).toThrow();
    expect(() => cleanBio(5)).toThrow();
  });

  test("players are base58 Solana addresses, case and all", () => {
    expect(looksLikePlayer("EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF")).toBe(true);
    expect(looksLikePlayer("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(looksLikePlayer("EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyx0")).toBe(false);
    expect(playerName({ player: "EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF", username: null })).toBe("EQmn…pyxF");
    expect(playerName({ player: "x", username: "pen" })).toBe("pen");
    const hue = playerHue("EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF");
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  test("avatar seeds: the address and a number, or a short safe word; none is the address", () => {
    const a = "EQmnM7EP6ewPvjq81cCKmcKKzXFi5WGuciHfDtTCpyxF";
    for (const ok of [`${a}:0`, `${a}:123456`, "pen", "ink_maker-7", null]) expect(avatarSeedProblem(ok)).toBeNull();
    for (const bad of [`${a}:1234567`, `${a}:x`, "a".repeat(33), "<svg>", "x y", "", "seed\n", "0x" + "f".repeat(64), 5, undefined]) expect(avatarSeedProblem(bad)).not.toBeNull();
    expect(avatarSeedOf({ player: a, avatarSeed: null })).toBe(a);
    expect(avatarSeedOf({ player: a, avatarSeed: `${a}:3` })).toBe(`${a}:3`);
  });

  test("one address for the service and one reading of its feed, web and phone", () => {
    expect(socialUrl("wss://api.skech.trade/solana/ws")).toBe("https://api.skech.trade/social");
    expect(socialUrl("ws://localhost:3104/ws")).toBe("http://localhost:3105");
    expect(socialUrl("ws://10.0.2.2:3104/ws")).toBe("http://10.0.2.2:3105");
    expect(socialUrl("wss://x/ws", "https://tunnel.example/")).toBe("https://tunnel.example");
    expect(socialSocketUrl("https://api.skech.trade/social")).toBe("wss://api.skech.trade/social/ws");
    const p = (player: string, username: string | null = null): PlayerProfile => ({ player, username, bio: "", avatar: false, avatarSeed: null, joinedAt: 0, followers: 0, following: 0 });
    const d = (id: string, player: string, at: number): PublicDrawing => ({ id, player, profile: p(player), at, updatedAt: at, stake: "1", settledStake: "0", paid: "0", owed: "0", pnl: "0", complete: false, pieces: [], tx: "t" });
    const now = 1_000_000;
    let s = applyFeed(EMPTY_FEED, { type: "snapshot", drawings: [d("A:1", "A", now)], activity: [], playing: [p("A")], counting: false, progress: 1 }, now);
    s = applyFeed({ ...s, connected: true }, { type: "drawing", drawing: d("B:1", "B", now) }, now);
    expect(s.drawings.map((x) => x.id)).toEqual(["B:1", "A:1"]);
    s = applyFeed(s, { type: "profile", profile: p("A", "pen") }, now);
    expect(s.drawings.find((x) => x.player === "A")?.profile.username).toBe("pen");
    expect(s.playing[0].username).toBe("pen");
    // A bare profile in presence does not hide the fuller one.
    s = applyFeed(s, { type: "presence", playing: [p("A"), p("B")] }, now);
    expect(s.profiles.A.username).toBe("pen");
    expect(remoteDrawings(s, "A", "everyone", new Set(), now).map((x) => x.player)).toEqual(["B"]);
    expect(remoteDrawings(s, "A", "following", new Set(), now)).toEqual([]);
    expect(visibleDrawings(s, "A", "me", new Set(), now).map((x) => x.player)).toEqual(["A"]);
    // Drawings quiet for two minutes drop off when the next one comes.
    s = applyFeed(s, { type: "drawing", drawing: d("C:1", "C", now + LIVE_MS + 1) }, now + LIVE_MS + 1);
    expect(s.drawings.map((x) => x.id)).toEqual(["C:1"]);
    expect(avatarChoices("A", 5, 2)).toEqual(["A", "A:5", "A:6"]);
    expect(socialMoney("1250000")).toBe("$1.25");
  });

  test("the live pen: compact points, and messages checked before they are passed on", () => {
    const pts = [{ t: 0, p: 0 }, { t: 16.4, p: 1.234 }, { t: 33, p: -2.5 }];
    expect(penPack(pts)).toEqual([0, 0, 16, 123, 33, -250]);
    expect(penUnpack(penPack(pts))).toEqual([{ t: 0, p: 0 }, { t: 16, p: 1.23 }, { t: 33, p: -2.5 }]);
    expect(penProblem({ type: "pen", id: "a-1", seq: 0, pts: [0, 0], t0: 1, p0: 82000, rt: 120, rp: 0.8 })).toBeNull();
    expect(penProblem({ type: "pen", id: "a-1", seq: 3, pts: [16, 5] })).toBeNull();
    expect(penProblem({ type: "pen-end", id: "a-1" })).toBeNull();
    expect(penProblem({ type: "pen", id: "a-1", seq: 0, pts: [0, 0] })).not.toBeNull();
    expect(penProblem({ type: "pen", id: "<x>", seq: 1, pts: [] })).not.toBeNull();
    expect(penProblem({ type: "pen", id: "a", seq: 1, pts: [1] })).not.toBeNull();
    expect(penProblem({ type: "pen", id: "a", seq: 1, pts: [1.5, 2] })).not.toBeNull();
    expect(penProblem({ type: "pen", id: "a", seq: 1, pts: Array(PEN_POINTS_PER_MESSAGE * 2 + 2).fill(0) })).not.toBeNull();
    expect(penProblem({ type: "pen", id: "a", seq: -1, pts: [] })).not.toBeNull();
    expect(penProblem(null)).not.toBeNull();
  });

  test("windows", () => {
    expect(windowStart("all", 1e12)).toBe(0);
    expect(windowStart("24h", 1e12)).toBe(1e12 - 86_400_000);
  });
});


test("Live feed deduplicates drawing events before grouping consecutive player runs", () => {
  const item = (drawing: string, player: string, kind: "placed" | "settled", amount: string) => ({ drawing, player, kind, amount } as SocialActivity);
  const latest = item("a1", "a", "settled", "50000");
  const feed = [latest, item("a1", "a", "placed", "10000"), item("a2", "a", "settled", "-20000"), item("b1", "b", "placed", "10000"), item("a3", "a", "settled", "10000")];
  const runs = activityRuns(feed);
  expect(runs.map((run) => run.map((item) => item.drawing))).toEqual([["a1", "a2"], ["b1"], ["a3"]]);
  expect(runs[0][0]).toBe(latest);
  expect(runs[0].reduce((sum, item) => sum + BigInt(item.amount), 0n)).toBe(30000n);
  expect(activityRuns(feed, 1)).toEqual([runs[0]]);
  expect(activityRuns([])).toEqual([]);
});
