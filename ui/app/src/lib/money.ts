/** Money as the app shows it, in one place: dollars to the cent, with thousands separators. */

/** Rounded to the cent, so sums of dimes do not drift. */
export const cents = (n: number) => Math.round(n * 100) / 100;

/** $1,234.56. The sign is dropped: see `signed`. */
export const money = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** SKT, counted in millionths: whole from 10 up, to a tenth below it, rounded down. */
export const skt = (e6: number) => {
  const n = e6 / 1e6;
  return n >= 10 || n === 0 ? Math.floor(n).toLocaleString("en-US") : (Math.floor(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
};

/** +$1.20, −$0.40 (a true minus), $0.00. */
export const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${money(n)}`;
