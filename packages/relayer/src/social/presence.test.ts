import { describe, expect, test } from "bun:test";
import type { PlayerProfile, PublicDrawing } from "@skech/core/social";
import { OPEN_MS, PLAYING_MS, Presence, SHOWN } from "./presence";

const profile = (player: string, username: string | null = null): PlayerProfile => ({ player, username, bio: "", avatar: false, avatarSeed: null, joinedAt: 0, followers: 0, following: 0 });
const drawing = (player: string, id: string, complete: boolean, at: number): PublicDrawing => ({ id: `${player}:${id}`, player, profile: profile(player), at, updatedAt: at, stake: "1", settledStake: complete ? "1" : "0", paid: "0", owed: "0", pnl: "0", complete, pieces: [], tx: "t" });

describe("playing now", () => {
  test("a piece in the last 30 s, or a drawing in play", () => {
    let now = 1_000_000;
    const p = new Presence(() => now);
    p.placed("A");
    p.saw(drawing("B", "1", false, now), "placed");
    expect(p.list().map((x) => x.player).sort()).toEqual(["A", "B"]);
    now += PLAYING_MS + 1;
    // A has placed nothing since; B's drawing is still in play.
    expect(p.list().map((x) => x.player)).toEqual(["B"]);
    p.saw(drawing("B", "1", true, now), "settled");
    expect(p.list()).toEqual([]);
    expect(p.size).toBe(0);
  });

  test("a drawing never heard to settle is let go", () => {
    let now = 0;
    const p = new Presence(() => now);
    p.saw(drawing("C", "1", false, now), "placed");
    now += OPEN_MS + 1;
    expect(p.size).toBe(0);
  });

  test("most recent first, at most SHOWN sent, and told only when it changes", () => {
    let now = 0;
    const p = new Presence(() => now);
    for (let i = 0; i < SHOWN + 10; i++) {
      now += 10;
      p.placed(`P${i}`);
    }
    expect(p.size).toBe(SHOWN + 10);
    const list = p.changed()!;
    expect(list).toHaveLength(SHOWN);
    expect(list[0].player).toBe(`P${SHOWN + 9}`);
    expect(p.changed()).toBeNull();
    p.profile(profile(`P${SHOWN + 9}`, "pen"));
    expect(p.changed()?.[0].username).toBe("pen");
  });

  test("bounded: a flood of players keeps the newest", () => {
    const p = new Presence(() => 0);
    for (let i = 0; i < 6_000; i++) p.placed(`X${i}`);
    expect(p.size).toBeLessThanOrEqual(5_000);
  });
});
