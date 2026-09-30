/** Money as the app shows it, in one place: dollars to the cent, with thousands separators. */

/** Rounded to the cent, so sums of dimes do not drift. */
export const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * 1,234.56 with `decimals` places, as en-US writes it. By hand: on Android, Hermes's toLocaleString goes through
 * Java for every number, and the screen formats some every frame.
 */
export const grouped = (n: number, decimals: number) => {
  const [whole, frac] = n.toFixed(decimals).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
};

/** SKT, counted in millionths: whole from 10 up, to a tenth below it, rounded down. */
export const skt = (e6: number) => {
  const n = e6 / 1e6;
  return n >= 10 || n === 0 ? grouped(Math.floor(n), 0) : String(Math.floor(n * 10) / 10);
};

/** $1,234.56. The sign is dropped: see `signed`. */
export const money = (n: number) => `$${grouped(Math.abs(n), 2)}`;

/** +$1.20, −$0.40 (a true minus), $0.00. */
export const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(n)}`;
