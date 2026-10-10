import { beforeEach, describe, expect, mock, test } from 'bun:test'

/*
  lib/feel.ts on stand-ins for the phone's audio and haptics, which record when each sound is started and each pulse
  is felt. Real time, not a fake clock: what is measured is how long the code between the judge finding a hit and the
  audio start call takes, and that nothing makes it wait.
*/

type Mark = { at: number; what: string }
const audioStarts: Mark[] = []
const pulses: Mark[] = []
const logs: string[] = []

const param = () => ({
  value: 0,
  setValueAtTime() {},
  linearRampToValueAtTime() {},
  exponentialRampToValueAtTime() {},
  cancelScheduledValues() {},
  setTargetAtTime() {},
})
const node = (extra: object = {}) => ({ connect: (n: unknown) => n, disconnect() {}, ...extra })
class FakeContext {
  state = 'running'
  currentTime = 0
  sampleRate = 24_000
  destination = node()
  createGain = () => node({ gain: param() })
  createBiquadFilter = () => node({ type: '', frequency: param(), Q: param() })
  createOscillator = () =>
    node({
      type: '',
      frequency: param(),
      start: () => audioStarts.push({ at: performance.now(), what: 'tone' }),
      stop() {},
    })
  createBufferSource = () =>
    node({
      buffer: null,
      loop: false,
      playbackRate: param(),
      start: () => audioStarts.push({ at: performance.now(), what: 'buffer' }),
      stop() {},
    })
  createBuffer = (_ch: number, length: number) => ({
    length,
    getChannelData: () => new Float32Array(length),
    copyToChannel() {},
  })
  resume = async () => {}
  suspend = async () => {}
}

const platform = { OS: 'ios' }
const vibrations: number[][] = []
mock.module('react-native', () => ({
  Platform: platform,
  Vibration: { cancel() {}, vibrate: (pattern: number[]) => void vibrations.push(pattern) },
}))
mock.module('react-native-audio-api', () => ({ AudioContext: FakeContext }))
mock.module('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  impactAsync: async (s: string) => void pulses.push({ at: performance.now(), what: s }),
  selectionAsync: async () => void pulses.push({ at: performance.now(), what: 'selection' }),
  notificationAsync: async (s: string) => void pulses.push({ at: performance.now(), what: s }),
}))
mock.module(new URL('../src/lib/practice.ts', import.meta.url).pathname, () => ({
  practice: () => ({ sound: true, haptics: true }),
}))
mock.module(new URL('../src/lib/storage.ts', import.meta.url).pathname, () => ({
  storage: { getBoolean: () => true, set() {} },
}))
;(globalThis as { __DEV__?: boolean }).__DEV__ = false
const info = console.info
console.info = (...a: unknown[]) => void logs.push(a.join(' '))

const { celebrate, feel, haptic } = await import('../src/lib/feel')
const microtask = () => new Promise<void>((r) => queueMicrotask(r))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const reset = () => {
  audioStarts.length = 0
  pulses.length = 0
  logs.length = 0
}

describe('a hit is heard and felt the instant it is found', () => {
  beforeEach(async () => {
    // Every cue before has had its say.
    await sleep(500)
    reset()
  })

  test('sound and touch start before the next frame, within a couple of milliseconds of the judge', async () => {
    const seen = performance.now()
    feel('hit', { multiple: 2.4, run: 0, seen })
    await microtask()
    expect(pulses.map((p) => p.what)).toEqual(['medium'])
    expect(audioStarts.length).toBeGreaterThan(0)
    const latency = audioStarts[0].at - seen
    expect(latency).toBeLessThan(5)
    expect(pulses[0].at - seen).toBeLessThan(5)
    info(
      `[feel.test] hit: judge → first audio start ${latency.toFixed(2)} ms, judge → haptic ${(pulses[0].at - seen).toFixed(2)} ms`,
    )
    info(`[feel.test] timing log: ${logs.find((l) => l.startsWith('[skech:feel] hit'))}`)
  })

  test('does not wait behind a piece going in that is still sounding', async () => {
    feel('placed')
    await sleep(10)
    const placedSounds = audioStarts.length
    const seen = performance.now()
    feel('hit', { multiple: 3, seen })
    await microtask()
    expect(audioStarts.length).toBeGreaterThan(placedSounds)
    const latency = audioStarts[placedSounds].at - seen
    expect(latency).toBeLessThan(5)
    info(`[feel.test] hit 10 ms after the placed clack: judge → audio start ${latency.toFixed(2)} ms`)
  })

  test('replaces the tail of the last hit pattern rather than buzzing over it', async () => {
    feel('run', { multiple: 2, run: 2 })
    await sleep(120)
    feel('hit', { multiple: 2 })
    await microtask()
    // The shared run's light pulses start at 0 and 61 ms. The big hit pulses start at 0, 64 and 128 ms:
    // a hit 90 ms later (past the merge window) cancels the last pulse, but not the one already felt at 64 ms.
    feel('big', { multiple: 12 })
    await microtask()
    await sleep(90)
    feel('hit', { multiple: 2 })
    await microtask()
    await sleep(200)
    expect(pulses.map((p) => p.what)).toEqual(['light', 'light', 'medium', 'heavy', 'heavy', 'medium'])
  })

  test('a round that ends on a hit rings its chord as the hit ends, not on top of it', async () => {
    const seen = performance.now()
    // The judge's last hit on a line and the line's close come in the same pass.
    feel('hit', { multiple: 2, seen })
    celebrate(1, 1)
    await microtask()
    const hitStarts = audioStarts.length
    expect(hitStarts).toBeGreaterThan(0)
    expect(audioStarts[0].at - seen).toBeLessThan(5)
    await sleep(150)
    expect(audioStarts.length).toBe(hitStarts)
    await sleep(250)
    expect(audioStarts.length).toBeGreaterThan(hitStarts)
    const after = audioStarts[hitStarts].at - seen
    expect(after).toBeGreaterThanOrEqual(235)
    expect(after).toBeLessThan(330)
    info(`[feel.test] round's chord after the hit that ended it: ${after.toFixed(0)} ms (the hit's own 240 ms)`)
  })

  test('a round with no hit ringing celebrates at once', async () => {
    // The last test's chord has had its turn.
    await sleep(600)
    const t = performance.now()
    celebrate(3, 2)
    expect(audioStarts.length).toBeGreaterThan(0)
    expect(audioStarts[0].at - t).toBeLessThan(5)
  })
})

test('Android plays the exact web pattern and taps do not cancel a celebration', async () => {
  await sleep(1600)
  platform.OS = 'android'
  celebrate(3, 3)
  expect(vibrations).toEqual([[0, 26, 40, 22, 40, 30, 40, 40, 110, 80]])
  haptic('tap')
  expect(vibrations).toHaveLength(1)
})
