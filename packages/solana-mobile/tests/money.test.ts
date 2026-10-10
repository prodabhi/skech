import { expect, test } from 'bun:test'
import { skt } from '../src/lib/money'

test('SKT reads whole from 10 up, to a tenth under it, never rounded up, as the web does', () => {
  expect(skt(0)).toBe('0')
  expect(skt(120_000_000)).toBe('120')
  expect(skt(1_234_567_890)).toBe('1,234')
  expect(skt(10_999_999)).toBe('10')
  expect(skt(4_990_000)).toBe('4.9')
  expect(skt(300_000)).toBe('0.3')
  expect(skt(2_000_000)).toBe('2')
})
