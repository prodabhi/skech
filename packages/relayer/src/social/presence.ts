/**
 * Who is playing now, from what they do: a piece placed in the last PLAYING_MS, or a drawing still in play. Kept in
 * memory, never more than MOST players, each with at most MOST_OPEN drawings, and pruned as time passes; the
 * worker tells every app when the set changes.
 */
import type { PlayerProfile, PublicDrawing } from "@skech/core/social";

export const PLAYING_MS = 30_000;
/** A drawing not heard of for this long is let go, settled or not: its settlement was missed. */
export const OPEN_MS = 180_000;
const MOST = 5_000;
const MOST_OPEN = 50;
/** How many the apps are sent: the most recent. The count is of all of them. */
export const SHOWN = 40;

type Entry = { profile: PlayerProfile; placedAt: number; open: Map<string, number> };

export class Presence {
  private players = new Map<string, Entry>();
  private told = "";

  constructor(private readonly now: () => number = Date.now) {}

  /** A piece placed, before anything else is known of it: the relayer's word, at once. */
  placed(player: string, profile?: PlayerProfile) {
    const e = this.entry(player, profile);
    e.placedAt = this.now();
  }

  /** A drawing as it now stands: open until every band is decided. */
  saw(drawing: PublicDrawing, kind: "placed" | "settled") {
    const e = this.entry(drawing.player, drawing.profile);
    e.profile = drawing.profile;
    if (kind === "placed") e.placedAt = Math.max(e.placedAt, Math.min(this.now(), drawing.updatedAt || this.now()));
    if (drawing.complete) e.open.delete(drawing.id);
    else {
      e.open.delete(drawing.id);
      e.open.set(drawing.id, this.now());
      while (e.open.size > MOST_OPEN) e.open.delete(e.open.keys().next().value!);
    }
  }

  /** A player's new name or face. */
  profile(profile: PlayerProfile) {
    const e = this.players.get(profile.player);
    if (e) e.profile = profile;
  }

  private entry(player: string, profile?: PlayerProfile): Entry {
    let e = this.players.get(player);
    if (!e) {
      e = { profile: profile ?? { player, username: null, bio: "", avatar: false, avatarSeed: null, joinedAt: 0, followers: 0, following: 0 }, placedAt: 0, open: new Map() };
      this.players.set(player, e);
      while (this.players.size > MOST) this.players.delete(this.players.keys().next().value!);
    }
    return e;
  }

  /** Forget who stopped: no recent piece and no drawing in play. */
  prune() {
    const now = this.now();
    for (const [player, e] of this.players) {
      for (const [id, at] of e.open) if (now - at > OPEN_MS) e.open.delete(id);
      if (!e.open.size && now - e.placedAt > PLAYING_MS) this.players.delete(player);
    }
  }

  /** Who is playing, most recent first. */
  list(): PlayerProfile[] {
    this.prune();
    const last = (e: Entry) => Math.max(e.placedAt, ...e.open.values());
    return [...this.players.values()].sort((a, b) => last(b) - last(a)).slice(0, SHOWN).map((e) => e.profile);
  }

  get size() {
    this.prune();
    return this.players.size;
  }

  /** The list, if it is not what the apps were last told (who, in what order, and their names and faces). */
  changed(): PlayerProfile[] | null {
    const list = this.list();
    const key = JSON.stringify(list.map((p) => [p.player, p.username, p.avatar, p.avatarSeed]));
    if (key === this.told) return null;
    this.told = key;
    return list;
  }
}
