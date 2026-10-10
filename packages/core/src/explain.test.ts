import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_PIECE_STAKE_E6 } from "./chain";
import { DEFAULT_TERMS, howItWorks, howItWorksSummary } from "./explain";

const state = readFileSync(join(import.meta.dir, "../../contracts/solana/programs/skech/src/state.rs"), "utf8");
/** A field of a `DEFAULT` in state.rs, as a number: `fee_bps: 400,` is 400; `26 * 7 * 86_400` is worked out. */
const field = (name: string) => {
  const m = new RegExp(`\\b${name}: ([0-9_ *]+),`).exec(state);
  if (!m) throw new Error(`${name} not in state.rs`);
  return m[1].split("*").reduce((n, x) => n * Number(x.trim().replaceAll("_", "")), 1);
};
const constant = (name: string) => Number(new RegExp(`const ${name}: \\w+ = ([0-9_]+);`).exec(state)?.[1].replaceAll("_", ""));

test("the defaults explained are the program's", () => {
  expect(DEFAULT_TERMS.feeBps).toBe(field("fee_bps"));
  expect(DEFAULT_TERMS.profitFeeBps).toBe(field("profit_fee_bps"));
  expect(DEFAULT_TERMS.holderFeeBps).toBe(field("holder_fee_bps"));
  expect(DEFAULT_TERMS.holderProfitFeeBps).toBe(field("holder_profit_fee_bps"));
  expect(DEFAULT_TERMS.sktHalfLifeSecs).toBe(field("half_life_secs"));
  expect(DEFAULT_TERMS.surplusHolderBps).toBe(field("surplus_holder_bps"));
  expect(DEFAULT_TERMS.walletCapBps).toBe(field("wallet_cap_bps"));
  expect(DEFAULT_TERMS.sktPerDollar).toBe(constant("SKT_PER_USDC"));
  expect(BigInt(DEFAULT_TERMS.minPieceStake)).toBe(MIN_PIECE_STAKE_E6);
});

const base = { difficulty: 55, horizon: 30, device: "browser" as const };
const text = (s: ReturnType<typeof howItWorks>) => s.flatMap((x) => [x.title, ...x.lines]).join("\n");

test("real play says the relayer's numbers", () => {
  const s = text(howItWorks({ ...base, mode: "real", network: "Solana devnet", testMoney: true, terms: { feeBps: 400, profitFeeBps: 1000, holderFeeBps: 300, holderProfitFeeBps: 800, sktHalfLifeSecs: 15_724_800, surplusHolderBps: 7500 } }));
  expect(s).toContain("4% of what you put in: 3% to SKT holders, 1% to skech.");
  expect(s).toContain("10% of the profit when you are paid: 8% to SKT holders, 2% to skech.");
  expect(s).toContain("75% of what the pool holds above its reserve. skech gets the other 25%.");
  expect(s).toContain("SKT halves every 26 weeks.");
  expect(s).toContain("No wallet can hold more than 10% of all SKT.");
  expect(s).toContain("at most 96¢ per dollar, before the profit fee");
  expect(s).toContain("at least 1¢");
  expect(s).toContain("test money");
  expect(s).not.toContain("The free trial and practice have no fees");
});

test("other terms are said as they are, and the holders' part is never more than the fee", () => {
  const s = text(howItWorks({ ...base, mode: "real", terms: { feeBps: 250, profitFeeBps: 500, holderFeeBps: 400, minPieceStake: "100000" } }));
  expect(s).toContain("2.5% of what you put in: 2.5% to SKT holders, 0% to skech.");
  expect(s).toContain("5% of the profit when you are paid: 5% to SKT holders, 0% to skech.");
  expect(s).toContain("at least 10¢");
});

test("the trial and practice say they have no fees, and what real play would charge", () => {
  for (const mode of ["paper", "practice"] as const) {
    const s = text(howItWorks({ ...base, mode }));
    expect(s).toContain("no fees");
    expect(s).toContain("4% of what you put in");
    expect(s).toContain("$10 of paper money, 1¢ a dot");
  }
  expect(text(howItWorks({ ...base, mode: "practice", device: "phone" }))).toContain("kept on this phone");
  expect(text(howItWorks({ ...base, mode: "practice" }))).toContain("at most 98¢ per dollar.");
  expect(text(howItWorks({ ...base, mode: "practice", difficulty: 51 }))).toContain("at most 99¢ per dollar.");
  expect(howItWorksSummary({ mode: "real", network: "Solana devnet" })).toBe("Real USDC on Solana devnet, on the live Bitcoin price.");
});

test("one idea to a line", () => {
  for (const mode of ["paper", "practice", "real"] as const) {
    for (const { lines } of howItWorks({ ...base, mode })) for (const line of lines) expect(line.length).toBeLessThanOrEqual(130);
  }
});
