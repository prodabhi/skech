import { describe, expect, test } from 'bun:test'
import { carryBars, KEEP_BARS, validTrade } from '../src/lib/market-buffer'

describe('market buffers', () => {
  test('quiet seconds preserve observed prices and a contiguous timeline', () => {
    const bars = [{ t: 1000, h: 105, l: 95, c: 100 }]
    expect(carryBars(bars, 4000)).toBe(true)
    expect(bars).toEqual([
      { t: 1000, h: 105, l: 95, c: 100 },
      ...[2000, 3000, 4000].map((t) => ({ t, h: 100, l: 100, c: 100 })),
    ])
    expect(carryBars(bars, 4000)).toBe(false)
  })

  test('a years-long outage fills only the retained window', () => {
    const bars = [{ t: 1000, h: 100, l: 100, c: 100 }]
    const until = 1000 + 10 * 365 * 86400 * 1000
    carryBars(bars, until)
    expect(bars).toHaveLength(KEEP_BARS)
    expect(bars[0].t).toBe(until - (KEEP_BARS - 1) * 1000)
    expect(bars.at(-1)?.t).toBe(until)
    expect(bars.every((bar, i) => !i || bar.t - bars[i - 1].t === 1000)).toBe(true)
  })

  test('rejects malformed timestamps and prices before they affect skew or arrays', () => {
    expect(validTrade(1, 1700000000000, 100)).toBe(true)
    for (const [id, time, price] of [
      [NaN, 1000, 1],
      [1, Infinity, 1],
      [1, 1.5, 1],
      [1, 1000, Infinity],
      [1, 1000, -1],
    ])
      expect(validTrade(id, time, price)).toBe(false)
    const bars = [{ t: 1000, h: 100, l: 100, c: 100 }]
    expect(carryBars(bars, Infinity)).toBe(false)
    expect(bars).toHaveLength(1)
  })
})
