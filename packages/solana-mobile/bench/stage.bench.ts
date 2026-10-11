/*
  The phone's stage, drawn frame after frame under bun on stand-ins for Skia, React Native and React, with a busy
  chart: ten minutes of prices, the map of multiples, the player's own ink (live, hit and missed), five other players'
  drawings and two live pens. What it measures is the JavaScript a frame costs (the part a phone's JS thread pays,
  besides the Skia calls themselves), how many calls cross to native, and how many native objects are made a frame:
  each one is a JSI host object Hermes must collect, with its memory counted against the next collection.

    bun bench/stage.bench.ts                 this checkout's stage
    STAGE_ROOT=/other/packages/solana-mobile bun bench/stage.bench.ts   another checkout's, for before and after

  It runs the stage idle, then with the pen down, and prints ms a frame (median and p95), calls and objects a frame.
*/
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Field, fieldJob, readLibrary, setDifficulty } from '../../core/src/dots'
import { INK_EDGE_CELLS, type InkBet, type Stroke } from '../../core/src/ink'

const ROOT = process.env.STAGE_ROOT ?? join(import.meta.dir, '..')
/** Native objects made, calls made across, and the memory those objects tell Hermes they hold (megabytes). */
const counts = { calls: 0, objects: 0, mb: 0 }
const call =
  <T>(ret?: T) =>
  (..._: unknown[]) => {
    counts.calls++
    return ret as T
  }
/** A host object: every method a call across, and the object itself counted once made. */
function host(): Record<string, unknown> {
  counts.objects++
  return new Proxy({} as Record<string, unknown>, {
    get(target, k) {
      if (k in target) return target[k as string]
      if (k === 'then') return undefined
      if (k === 'x' || k === 'y' || k === 'width' || k === 'height') return 0
      return call(undefined)
    },
  })
}
const canvas = new Proxy({} as Record<string, unknown>, { get: (_, k) => (k === 'then' ? undefined : call(undefined)) })
const recorder = () => {
  counts.objects++
  // JsiSkPictureRecorder::getMemoryPressure: 1 MB.
  counts.mb += 1
  return {
    beginRecording: (..._: unknown[]) => (counts.calls++, canvas),
    finishRecordingAsPicture: () => (counts.calls++, host()),
  }
}
const font = {
  measureText: (s: string) => (counts.calls++, { width: s.length * 6 }),
  getMetrics: () => (counts.calls++, { ascent: -9, descent: 3 }),
}
const Skia = {
  Color: (_: string) => (counts.objects++, new Float32Array(4)),
  Paint: () => host(),
  Path: { Make: () => host() },
  XYWHRect: () => host(),
  RRectXY: () => host(),
  PictureRecorder: recorder,
  // JsiSkShader::getMemoryPressure: 1 MB.
  Shader: { MakeRadialGradient: () => ((counts.mb += 1), host()) },
  SVG: { MakeFromString: () => host() },
  Surface: { Make: () => ({ getCanvas: () => canvas, makeImageSnapshot: () => host() }) },
}
mock.module('@shopify/react-native-skia', () => ({
  Skia,
  BlendMode: { DstOut: 1, DstIn: 2 },
  ClipOp: { Intersect: 1 },
  PaintStyle: { Stroke: 1 },
  StrokeCap: { Round: 1 },
  StrokeJoin: { Round: 1 },
  TileMode: { Clamp: 0 },
  matchFont: () => font,
  Canvas: 'Canvas',
  Picture: 'Picture',
}))
mock.module('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Platform: { select: (o: { default: unknown }) => o.default },
  View: 'View',
}))
const gesture: Record<string, (e: { x: number; y: number; state?: number }) => void> = {}
const chain: Record<string, unknown> = {}
for (const k of ['minDistance', 'shouldCancelWhenOutside', 'runOnJS']) chain[k] = () => chain
for (const k of ['onBegin', 'onUpdate', 'onEnd', 'onFinalize'])
  chain[k] = (f: (e: { x: number; y: number }) => void) => {
    gesture[k] = f
    return chain
  }
mock.module('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => chain },
  GestureDetector: 'GestureDetector',
  State: { CANCELLED: 3 },
}))
mock.module('react-native-reanimated', () => ({
  useReducedMotion: () => false,
  useSharedValue: <T>(v: T) => ({ value: v }),
}))
const effects: (() => unknown)[] = []
mock.module('react', () => ({
  memo: (f: unknown) => ({ type: f }),
  useEffect: (f: () => unknown) => effects.push(f),
  useMemo: <T>(f: () => T) => f(),
  useRef: <T>(v: T) => ({ current: v }),
}))
const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props })
mock.module('react/jsx-runtime', () => ({ jsx, jsxs: jsx, Fragment: 'Fragment' }))
mock.module('react/jsx-dev-runtime', () => ({ jsxDEV: jsx, Fragment: 'Fragment' }))
mock.module(join(ROOT, 'src/lib/feel.ts'), () => ({ feel() {}, pen: { down() {}, up() {}, move() {} } }))
mock.module(join(ROOT, 'src/lib/avatar.ts'), () => ({ dylanXml: () => '<svg/>', faceOf: () => '' }))

/* ---- the chart: ten minutes of prices, a trade every ~80 ms, and the map for this second ---- */
const now0 = Date.now()
const second = Math.floor(now0 / 1000) * 1000
let seed = 7
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
let price = 100_000
const bars: { t: number; h: number; l: number; c: number }[] = []
const ticks: { t: number; p: number }[] = []
for (let t = second - 660_000; t <= now0; t += 80) {
  price *= 1 + (rand() - 0.5) * 0.00002
  const s = Math.floor(t / 1000) * 1000
  const last = bars.at(-1)
  if (last && last.t === s) {
    last.h = Math.max(last.h, price)
    last.l = Math.min(last.l, price)
    last.c = price
  } else bars.push({ t: s, h: price, l: price, c: price })
  ticks.push({ t, p: price })
}
bars.splice(0, bars.length - 660)
ticks.splice(0, ticks.length - 4000)
const lib = readLibrary(new Uint8Array(readFileSync(join(import.meta.dir, '../assets/dots-lib.bin'))))
setDifficulty(55, 50)
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

/* ---- ink: three lines of the player's own, each with cells live, hit and missed in the last two seconds ---- */
const stroke = (t0: number, p0: number, n: number): Stroke => ({
  t0,
  p0,
  rt: 260,
  rp: 1.6,
  pts: Array.from({ length: n }, (_, i) => ({ t: i * 40, p: Math.sin(i / 6) * 4 })),
})
const bet = (id: string, t0: number, p0: number): InkBet => {
  const st = stroke(t0, p0, 120)
  const cells = Array.from({ length: 30 }, (_, i) => {
    const t = Math.floor((t0 + i * 160) / 1000) * 1000
    const status = t < now0 - 3000 ? 'miss' : t < now0 ? (i % 2 ? 'hit' : 'miss') : 'live'
    return {
      t,
      lo: p0 - 2 + (i % 3),
      hi: p0 + (i % 3),
      area: 1,
      multiple: 2 + (i % 5),
      status: status as 'live' | 'hit' | 'miss',
      range: [p0 - 1, p0 + 1] as [number, number],
    }
  })
  return {
    model: 'ladder-v1',
    id,
    placedAt: t0,
    openAt: t0,
    perUnit: 0.1,
    step,
    cell: 0.2,
    edgeCells: INK_EDGE_CELLS,
    stroke: st,
    group: id,
    drawn: cells.map(({ t, lo, hi, area }) => ({ t, lo, hi, area })),
    cells,
    status: 'live',
  }
}
const bets = [bet('a', now0 - 2500, price), bet('b', now0 - 1800, price + 6), bet('c', now0 + 2500, price - 5)]

/* ---- the community: five drawings, two pens being drawn ---- */
const profile = (i: number) => ({
  player: `Player${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  username: `p${i}`,
  bio: '',
  avatar: false,
  avatarSeed: null,
  joinedAt: 0,
  followers: 0,
  following: 0,
})
const drawings = Array.from({ length: 5 }, (_, i) => {
  const t0 = now0 + 3000 + i * 700
  const st = stroke(t0, price + (i - 2) * 6, i === 3 ? 1 : 90)
  return {
    id: `d${i}`,
    player: profile(i).player,
    profile: profile(i),
    at: now0,
    updatedAt: now0,
    stake: '900000',
    settledStake: '0',
    paid: '0',
    owed: '0',
    pnl: '0',
    complete: false,
    pieces: [
      {
        betId: `d${i}:0`,
        stroke: st,
        from: 0,
        sections: [0, 1, 2].map((k) => ({
          second: k + 1,
          lo: String(Math.round((price - 2) * 1e8)),
          hi: String(Math.round((price + 2) * 1e8)),
          stake: '100000',
          rung: 2,
        })),
        openAt: Math.floor(t0 / 1000) * 1000,
        unit: '20000000',
        hitMask: 0,
        missMask: 0,
      },
    ],
    tx: 'mock',
  }
})
const pens = [0, 1].map((i) => ({
  key: `k${i}`,
  player: profile(5 + i).player,
  profile: profile(5 + i),
  t0: now0 + 6000,
  p0: price + i * 8,
  rt: 260,
  rp: 1.6,
  pts: Array.from({ length: i ? 1 : 60 }, (_, k) => ({ t: k * 80, p: Math.cos(k / 8) * 3 })),
  at: 0,
  ended: false,
  shown: 0,
}))
mock.module(join(ROOT, 'src/lib/social.ts'), () => ({
  livePens: () => pens,
  remoteDrawings: () => drawings,
  visibleSocialDrawings: () => drawings,
  penFlush() {},
  penLift() {},
  openPlayerProfile() {},
}))

/* ---- a clock that stands still, so every frame draws the same scene (the hits stay lit) ---- */
let clock = now0
Date.now = () => clock

/* ---- the stage, mounted by hand ---- */
let raf: ((t: number) => void) | null = null
globalThis.requestAnimationFrame = ((f: (t: number) => void) => ((raf = f), 1)) as typeof requestAnimationFrame
globalThis.cancelAnimationFrame = () => {}
const { Stage } = (await import(join(ROOT, 'src/components/app/ink/stage.tsx'))) as {
  Stage: { type: (p: unknown) => { props: Record<string, unknown> } }
}
const game = {
  current: {
    bars,
    ticks,
    skew: 0,
    field,
    placeLead: 0,
    step,
    priceStep: step,
    marketStep: step,
    viewport: { width: 390, height: 700 },
    displayPrice: price,
    perDot: 0.1,
    pen: 'medium',
    cell: 0.2,
    bets,
    quote: () => null,
    fx: [] as unknown[],
    dark: false,
  },
}
const tree = Stage.type({ game, onPlace: () => null, onPreview: () => {}, onViewport: () => {} })
for (const f of effects.splice(0)) f()
// The layout: a phone's stage.
const find = (n: unknown): ((e: unknown) => void) | undefined => {
  const node = n as { props?: Record<string, unknown> } | null
  if (!node?.props) return undefined
  if (typeof node.props.onLayout === 'function') return node.props.onLayout as (e: unknown) => void
  const kids = node.props.children
  for (const k of Array.isArray(kids) ? kids : [kids]) {
    const got = find(k)
    if (got) return got
  }
}
find(tree)?.({ nativeEvent: { layout: { width: 390, height: 700 } } })

const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]
function run(label: string, frames: number, each?: (i: number) => void) {
  const ms: number[] = []
  let calls = 0,
    objects = 0,
    mb = 0
  for (let i = 0; i < frames; i++) {
    clock = now0 + (i % 30) * 11
    each?.(i)
    // Every frame past the stage's half-rate gate: it draws whenever 30 ms have passed since the last.
    const until = performance.now() + 0.5
    while (performance.now() < until);
    counts.calls = counts.objects = counts.mb = 0
    const f = raf!
    const t0 = performance.now()
    f(t0)
    ms.push(performance.now() - t0)
    calls += counts.calls
    objects += counts.objects
    mb += counts.mb
  }
  const drawn = ms.filter((m) => m > 0.02).length || 1
  console.log(
    `${label.padEnd(10)} ${pct(ms, 50).toFixed(3)} ms median, ${pct(ms, 95).toFixed(3)} p95, ${Math.round(calls / drawn)} calls/frame, ${Math.round(objects / drawn)} native objects/frame, ${(mb / drawn).toFixed(1)} MB claimed/frame`,
  )
}
// Warm up (the map's tiles are made on the first frame), then idle, then with the pen down and moving.
run('warm-up', 200)
run('idle', 600)
gesture.onBegin({ x: 300, y: 350 })
run('drawing', 600, (i) => gesture.onUpdate({ x: 300 + (i % 60), y: 350 + 30 * Math.sin(i / 10) }))
gesture.onEnd({ x: 330, y: 350 })
process.exit(0)
