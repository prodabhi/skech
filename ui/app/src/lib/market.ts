/** `7Qfww9…Njng`. Long enough to compare two by eye, short enough for a chip. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
