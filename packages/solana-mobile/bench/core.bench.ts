/*
  The game's hot JavaScript on the phone, call by call: pricing the stroke under the pen (twenty times a second while
  drawing), the map's tiles (once a second, in one frame), placing a piece, judging every bet on each trade batch,
  the chain's holds, and the social feed's reducer. Run with the JIT off it is a fair stand-in for Hermes, which
  interprets:

    BUN_JSC_useJIT=0 bun bench/core.bench.ts

  Prints ms a call and ms a second of play at the rate the app calls each.
*/
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Field, fieldJob, readLibrary, setDifficulty } from '../../core/src/dots'
import { INK_EDGE_CELLS, type InkBet, judge, openOn, placeInk, type Stroke } from '../../core/src/ink'
import { roundedTerms } from '../../core/src/odds'
import { Holds } from '../../core/src/optimistic'
import { applyFeed, EMPTY_FEED, type PublicDrawing, type SocialMessage } from '../../core/src/social'

const lib = readLibrary(new Uint8Array(readFileSync(join(import.meta.dir, '../assets/dots-lib.bin'))))
setDifficulty(55, 50)
const second = 1_700_000_000_000
const price = 100_000
const step = 5
const job = fieldJob(
  lib,
  { price, sigma: 0.00006, momentum: 0, wick: 0.1 },
  second - 1000,
  step * 0.2,
  0.2,
  INK_EDGE_CELLS,
  { perRow: false, seconds: 20 },
)
while (!job.run(10_000));
const field: Field = job.result()

function time(label: string, perSecond: number, n: number, f: (i: number) => void) {
  for (let i = 0; i < Math.min(20, n); i++) f(i)
  const t0 = performance.now()
  for (let i = 0; i < n; i++) f(i)
  const ms = (performance.now() - t0) / n
  console.log(
    `${label.padEnd(44)} ${ms.toFixed(3).padStart(8)} ms a call   ${(ms * perSecond).toFixed(2).padStart(7)} ms a second (${perSecond}/s)`,
  )
}

const stroke = (n: number): Stroke => ({
  t0: second + 2500,
  p0: price,
  rt: 260,
  rp: 1.6,
  pts: Array.from({ length: n }, (_, i) => ({ t: i * 30, p: Math.sin(i / 8) * 6 })),
})

// The pen's quote: the whole stroke so far priced on the map, twenty times a second.
for (const n of [20, 100, 300]) {
  const st = stroke(n)
  time(`quote, a ${n}-point stroke`, 20, 200, () => roundedTerms(field, second + 500, step, 0.1).line(st))
}
// The map's tiles: a tap's quote at each tile's middle, about 130 tiles, once a second when the map is new.
time("the map's tiles (130 taps), once a second", 1, 20, () => {
  const terms = roundedTerms(field, second + 500, step, 1)
  for (let k = 0; k < 130; k++)
    terms.line({
      t0: second + 2500 + (k % 6) * 2000,
      p0: price + ((k / 6) | 0) * 2 - 20,
      pts: [{ t: 0, p: 0 }],
      rt: 260,
      rp: 1.6,
    })
})
// A piece placed: the ink since the last, about seven times a second while drawing.
{
  const prev = stroke(150)
  const now = stroke(160)
  time('place a piece (10 new points)', 7, 200, () =>
    placeInk(now, prev, 0.1, step, second + 500, 'a:1', 'a', INK_EDGE_CELLS),
  )
}
// Judging: ten live bets against the newest bar, on each trade batch (up to twenty a second).
{
  const bets: InkBet[] = []
  for (let i = 0; i < 10; i++) {
    const placed = placeInk(stroke(40 + i * 10), null, 0.1, step, second + 500, `b${i}:0`, `b${i}`, INK_EDGE_CELLS)!
    bets.push(openOn(placed, field) ?? placed)
  }
  const bar = { t: second + 3000, h: price + 1, l: price - 1, c: price }
  time('judge ten live bets against a bar', 20, 2000, () => {
    for (const b of bets) judge(b, bar, false, price)
  })
}
// The chain's holds: a stake held and landed, a win held, the total, for each piece and hit.
{
  const holds = new Holds()
  time('holds: hold, land, total (one piece)', 10, 2000, (i) => {
    holds.hold(`stake:${i}`, -0.1)
    holds.hold(`win:${i}:1`, 0.2)
    holds.land(`stake:${i}`, -0.1)
    holds.total()
    if (i % 50 === 49) holds.landAll('')
  })
}
// The social feed: a drawing message folded into a full feed (eighty drawings, five hundred profiles), a few a second.
{
  const profile = (i: number) => ({
    player: `P${i}`.padEnd(40, 'x'),
    username: `p${i}`,
    bio: '',
    avatar: false,
    avatarSeed: null,
    joinedAt: 0,
    followers: 0,
    following: 0,
  })
  const drawing = (i: number, at: number): PublicDrawing => ({
    id: `d${i}`,
    player: profile(i).player,
    profile: profile(i),
    at,
    updatedAt: at,
    stake: '100000',
    settledStake: '0',
    paid: '0',
    owed: '0',
    pnl: '0',
    complete: false,
    pieces: [
      {
        betId: `d${i}:0`,
        stroke: stroke(60),
        from: 0,
        sections: [],
        openAt: second,
        unit: '1',
        hitMask: 0,
        missMask: 0,
      },
    ],
    tx: 'x',
  })
  let state = applyFeed(EMPTY_FEED, {
    type: 'snapshot',
    drawings: Array.from({ length: 80 }, (_, i) => drawing(i, Date.now())),
    activity: [],
    playing: Array.from({ length: 500 }, (_, i) => profile(i)),
    counting: false,
    progress: 1,
  })
  const messages: SocialMessage[] = Array.from({ length: 100 }, (_, i) => ({
    type: 'drawing',
    drawing: drawing(i % 90, Date.now()),
  }))
  time('feed: fold in one drawing message', 5, 2000, (i) => {
    state = applyFeed(state, messages[i % 100])
  })
  const raw = messages.map((m) => JSON.stringify(m))
  time('feed: parse one drawing message', 5, 2000, (i) => JSON.parse(raw[i % 100]))
}
process.exit(0)
