import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { type Field, field, fieldJob, readLibrary, setDifficulty } from '@skech/core/dots'
import { INK_CELL, INK_EDGE_CELLS, openOn, placeInk, type Stroke } from '@skech/core/ink'
import { type FieldAsk, FieldMaker, PHONE_SECONDS } from '../src/lib/field'

/*
  The phone makes its map of multiples a slice a frame. However the work is cut up, every number must be the one the
  map made in one go gives: these tests make each map whole, then through the maker, and compare them exactly.
*/

const frames = new Map<number, FrameRequestCallback>()
let next = 0
const originalRequest = globalThis.requestAnimationFrame
const originalCancel = globalThis.cancelAnimationFrame
globalThis.requestAnimationFrame = (callback) => {
  frames.set(++next, callback)
  return next
}
globalThis.cancelAnimationFrame = (id) => {
  frames.delete(id)
}
afterEach(() => frames.clear())
process.on('exit', () => {
  globalThis.requestAnimationFrame = originalRequest
  globalThis.cancelAnimationFrame = originalCancel
})
const lib = readLibrary(new Uint8Array(readFileSync(new URL('../assets/dots-lib.bin', import.meta.url))))
const asks: FieldAsk[] = [
  {
    id: 1,
    at: 1700000000000,
    step: 2,
    cell: 0.2,
    difficulty: 70,
    least: 50,
    f: { price: 100000, sigma: 0.00008, momentum: 0.2, wick: 0.15 },
  },
  {
    id: 2,
    at: 1700000001000,
    step: 5,
    cell: 0.5,
    difficulty: 55,
    least: 50,
    f: { price: 64000, sigma: 0.0002, momentum: -0.4, wick: 0.3 },
  },
  {
    id: 3,
    at: 1700000002000,
    step: 1,
    cell: 0.1,
    difficulty: 30,
    least: 20,
    f: { price: 121000, sigma: 0.00004, momentum: 0, wick: 0.05 },
  },
]

/** The map made in one go, as it would be with no frames to keep. */
const whole = (ask: FieldAsk) => {
  setDifficulty(ask.difficulty, ask.least)
  const job = fieldJob(lib, ask.f, ask.at, ask.step, ask.cell, INK_EDGE_CELLS, {
    perRow: false,
    seconds: PHONE_SECONDS,
  })
  job.run(Infinity)
  return job.result()
}
/** The map made `n` paths at a time. */
const inRuns = (ask: FieldAsk, n: number) => {
  setDifficulty(ask.difficulty, ask.least)
  const job = fieldJob(lib, ask.f, ask.at, ask.step, ask.cell, INK_EDGE_CELLS, {
    perRow: false,
    seconds: PHONE_SECONDS,
  })
  while (!job.run(n));
  return job.result()
}
const drain = () => {
  let count = 0
  while (frames.size && count++ < 5000) {
    const [id, callback] = frames.entries().next().value!
    frames.delete(id)
    callback(performance.now())
  }
  return count
}

test('any size of run gives the map made in one go, number for number', () => {
  for (const ask of asks) {
    const expected = whole(ask)
    // 1 and 256 bound the maker's runs now; 400 and 4000 were where they started and could grow to before.
    for (const n of [1, 7, 32, 256, 400, 4000]) expect(inRuns(ask, n)).toEqual(expected)
  }
})

test('the maker, a slice a frame, finishes with exactly the one-go map', () => {
  for (const ask of asks) {
    const expected = whole(ask)
    let result: Field | null = null
    const maker = new FieldMaker(lib, (id, value) => {
      expect(id).toBe(ask.id)
      result = value
    })
    maker.ask(ask)
    const count = drain()
    expect(maker.busy).toBe(false)
    expect(count).toBeLessThan(5000)
    expect(result as Field | null).toEqual(expected)
  }
})

test('a map asked for while one is being made is made next, with its own difficulty', () => {
  const done = new Map<number, Field>()
  const maker = new FieldMaker(lib, (id, value) => done.set(id, value))
  maker.ask(asks[0])
  maker.ask(asks[1])
  maker.ask(asks[2])
  drain()
  // The one between is skipped: only the newest waiting is worth making.
  expect([...done.keys()]).toEqual([1, 3])
  expect(done.get(1)).toEqual(whole(asks[0]))
  expect(done.get(3)).toEqual(whole(asks[2]))
})

test('stopping odds work cancels the queued frame and emits no result', () => {
  let completed = false
  const maker = new FieldMaker(lib, () => {
    completed = true
  })
  maker.ask(asks[0])
  maker.stop()
  expect(frames.size).toBe(0)
  expect(maker.busy).toBe(false)
  expect(completed).toBe(false)
})

test('a map finished at once, part made or waiting, is exactly the one-go map, and is not made twice', () => {
  for (const ask of asks) {
    const expected = whole(ask)
    let delivered = 0
    const maker = new FieldMaker(lib, () => delivered++)
    maker.ask(ask)
    // A few slices in, then the rest at once.
    for (let i = 0; i < 3 && frames.size; i++) {
      const [id, callback] = frames.entries().next().value!
      frames.delete(id)
      callback(performance.now())
    }
    expect(maker.finishNow((a) => a.at === ask.at)).toEqual(expected)
    expect(delivered).toBe(1)
    expect(maker.busy).toBe(false)
    // Asked again: the same map, kept, not made again.
    expect(maker.finishNow((a) => a.at === ask.at)).toEqual(expected)
    expect(delivered).toBe(1)
    expect(maker.finishNow((a) => a.at === ask.at + 1000)).toBeNull()
    frames.clear()
  }
  // One waiting behind another: started and finished at once, the first finished on the way.
  const done = new Map<number, Field>()
  const maker = new FieldMaker(lib, (id, value) => done.set(id, value))
  maker.ask(asks[0])
  maker.ask(asks[1])
  expect(maker.finishNow((a) => a.id === 2)).toBeNull()
  frames.clear()
})

test("a drawing opened on the phone's map is priced exactly as on the full map of the paths", () => {
  for (const ask of asks) {
    setDifficulty(ask.difficulty, ask.least)
    // In a drawing's own cells, as the app asks for its maps.
    const full = field(lib, ask.f, ask.at, ask.step, INK_CELL, INK_EDGE_CELLS)
    const own = whole({ ...ask, cell: INK_CELL })
    const unit = ask.step / INK_CELL
    let compared = 0
    for (let k = 0; k < 40; k++) {
      // Lines from the wait line out to the phone map's last second, above and below the price.
      const st: Stroke = { t0: ask.at + 1200 + k * 300, p0: ask.f.price + (k - 20) * unit * 0.6, rt: 260, rp: unit * 0.35, pts: Array.from({ length: 1 + (k % 9) * 6 }, (_, i) => ({ t: i * 90, p: Math.sin(i / 3) * unit })) }
      const bet = placeInk(st, null, 0.1, unit, ask.at - 500, `l${k}:0`, `l${k}`, INK_EDGE_CELLS)
      if (!bet || !bet.drawn.every((c) => Math.round((c.t - ask.at) / 1000) - 1 < own.seconds)) continue
      const priced = openOn(bet, own)
      expect(priced).toEqual(openOn(bet, full))
      if (priced?.status === 'live') compared++
    }
    expect(compared).toBeGreaterThan(10)
  }
})
