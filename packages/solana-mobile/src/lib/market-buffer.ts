import type { Bar } from '@skech/core/dots'

export const KEEP_BARS = 660

/** Carry quiet seconds forward without allocating an entire outage's history. */
export function carryBars(bars: Bar[], until: number) {
  const last = bars.at(-1)
  if (!last || !Number.isSafeInteger(until) || until <= last.t) return false
  const start = Math.max(last.t + 1000, until - (KEEP_BARS - 1) * 1000)
  if (start > last.t + 1000) bars.length = 0
  for (let t = start; t <= until; t += 1000) bars.push({ t, h: last.c, l: last.c, c: last.c })
  if (bars.length > KEEP_BARS) bars.splice(0, bars.length - KEEP_BARS)
  return true
}

export function validTrade(id: number, t: number, p: number) {
  return Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(t) && t > 0 && Number.isFinite(p) && p > 0
}
