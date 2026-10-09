/**
 * The drawings in play, in memory: what the live feed is told the moment a placement or settlement is heard, without
 * waiting on the database (a round trip to a pooler far away is a tenth of a second, and a busy game queued them up
 * behind each other: half a minute late). The database is written after, and stays the record; this is only the
 * last few minutes, a few hundred drawings at most, and it computes each drawing's totals exactly as the store does.
 */
import { createHash } from "node:crypto";
import { decodeStroke } from "@skech/core/chain";
import type { DrawingPiece, PlayerProfile, PublicDrawing } from "@skech/core/social";
import type { Placement, Settlement } from "./store";

const MOST_DRAWINGS = 500;
const MOST_PIECES = 5_000;
/** How long a drawing is kept after it last changed. */
export const KEEP_MS = 10 * 60_000;

type Piece = { piece: DrawingPiece; drawing: string; strokeHash: string | null; paid: bigint; owed: bigint; decided: number };
type Held = { drawing: PublicDrawing; pieces: string[] };

export const strokeHash = (stroke: string) => createHash("sha256").update(Buffer.from(stroke.replace(/^0x/, ""), "hex")).digest("hex");

/** A stroke as the feed draws it, or null for bytes that are not one. */
export function strokeShape(stroke: string): { stroke: NonNullable<DrawingPiece["stroke"]>; from: number } | null {
  try {
    const d = decodeStroke(stroke as `0x${string}`);
    return d.rt > 0 && d.rp > 0 && d.pts.length ? { stroke: { t0: d.t0, p0: d.p0, rt: d.rt, rp: d.rp, pts: d.pts }, from: d.from } : null;
  } catch {
    return null;
  }
}

export class LiveBook {
  private drawings = new Map<string, Held>();
  private pieces = new Map<string, Piece>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A piece placed: the drawing as it now stands, or null if this piece was already in. `stroke` is kept only if it hashes to `strokeHash`, when there is one. */
  placed(p: Placement, profile: PlayerProfile): PublicDrawing | null {
    if (this.pieces.has(p.betId)) {
      // Seen before; a stroke may still come with it.
      return p.stroke ? this.stroke(p.betId, p.stroke, !p.strokeHash) : null;
    }
    const given = p.stroke ? strokeHash(p.stroke) : null;
    const hash = p.strokeHash?.toLowerCase() ?? given;
    const id = `${p.player}:${p.drawing}`;
    const shape = given && given === hash ? strokeShape(p.stroke!) : null;
    const piece: DrawingPiece = { betId: p.betId, stroke: shape?.stroke ?? null, ...(shape ? { from: shape.from } : {}), sections: p.sections, openAt: Number(p.openAt), unit: p.unit.toString(), hitMask: 0, missMask: 0, expiredMask: 0 };
    let held = this.drawings.get(id);
    if (!held) {
      held = { drawing: { id, player: p.player, profile, at: Number(p.openAt), updatedAt: Number(p.openAt), stake: "0", settledStake: "0", paid: "0", owed: "0", pnl: "0", complete: false, pieces: [], tx: p.tx }, pieces: [] };
      this.drawings.set(id, held);
    }
    held.pieces.push(p.betId);
    this.pieces.set(p.betId, { piece, drawing: id, strokeHash: hash, paid: 0n, owed: 0n, decided: 0 });
    held.drawing.profile = profile;
    this.prune();
    return this.total(held, Number(p.openAt));
  }

  /** A settlement of a piece in play: null if the piece is not here, or nothing new was decided. */
  settled(s: Settlement): PublicDrawing | null {
    const k = this.pieces.get(s.betId);
    if (!k) return null;
    const hit = s.hitMask >>> 0, miss = s.missMask >>> 0, expired = (s.expiredMask ?? 0) >>> 0;
    const mask = (hit | miss | expired) >>> 0;
    // A band decides once, as in the store.
    if ((k.decided & mask) !== 0) return null;
    k.decided = (k.decided | mask) >>> 0;
    k.piece = { ...k.piece, hitMask: (k.piece.hitMask | hit) >>> 0, missMask: (k.piece.missMask | miss) >>> 0, expiredMask: ((k.piece.expiredMask ?? 0) | expired) >>> 0 };
    k.paid += s.paid;
    k.owed += s.owed;
    const held = this.drawings.get(k.drawing);
    return held ? this.total(held, s.at ?? this.now()) : null;
  }

  /**
   * A stroke for a piece in play, from a player's app: kept if it hashes to the chain's hash and the piece has none.
   * `trusted`: the relayer's, for a piece whose hash is not known here.
   */
  stroke(betId: string, stroke: string, trusted = false): PublicDrawing | null {
    const k = this.pieces.get(betId);
    if (!k || k.piece.stroke) return null;
    if (k.strokeHash ? k.strokeHash !== strokeHash(stroke) : !trusted) return null;
    const shape = strokeShape(stroke);
    if (!shape) return null;
    k.piece = { ...k.piece, stroke: shape.stroke, from: shape.from };
    const held = this.drawings.get(k.drawing);
    return held ? this.total(held, held.drawing.updatedAt) : null;
  }

  /** Whether a piece is here, and the hash its stroke must have. */
  has(betId: string) {
    return this.pieces.has(betId);
  }

  profile(profile: PlayerProfile) {
    for (const held of this.drawings.values()) if (held.drawing.player === profile.player) held.drawing = { ...held.drawing, profile };
  }

  private total(held: Held, at: number): PublicDrawing {
    let stake = 0n, settled = 0n, paid = 0n, owed = 0n, complete = true;
    const pieces: DrawingPiece[] = [];
    for (const bet of held.pieces) {
      const k = this.pieces.get(bet);
      if (!k) continue;
      pieces.push(k.piece);
      k.piece.sections.forEach((section, i) => {
        stake += BigInt(section.stake);
        if ((k.decided & (1 << i)) !== 0) settled += BigInt(section.stake);
        else complete = false;
      });
      paid += k.paid;
      owed += k.owed;
    }
    // A new object each time: the apps keep the drawing they were sent, and compare by reference.
    held.drawing = { ...held.drawing, pieces, updatedAt: Math.max(held.drawing.updatedAt, at), at: Math.min(held.drawing.at, ...pieces.map((p) => p.openAt)), stake: stake.toString(), settledStake: settled.toString(), paid: paid.toString(), owed: owed.toString(), pnl: (paid + owed - settled).toString(), complete };
    return held.drawing;
  }

  /** Drawings quiet for KEEP_MS go, and the oldest past the caps. */
  prune() {
    const now = this.now();
    for (const [id, held] of this.drawings) {
      if (now - held.drawing.updatedAt <= KEEP_MS && this.drawings.size <= MOST_DRAWINGS && this.pieces.size <= MOST_PIECES) break;
      this.drawings.delete(id);
      for (const bet of held.pieces) this.pieces.delete(bet);
    }
  }

  /** Drawings that changed in the last `ms`, newest first. */
  recent(ms = 120_000): PublicDrawing[] {
    const since = this.now() - ms;
    return [...this.drawings.values()].map((h) => h.drawing).filter((d) => d.updatedAt > since).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get size() {
    return this.drawings.size;
  }
}
