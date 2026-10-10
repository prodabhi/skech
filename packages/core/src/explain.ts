import { bestE3 } from "./chain";
import { PAPER_MS, PAPER_PER_DOT, PAPER_START } from "./paper";

/**
 * How it works, in words, once for the web and the phone: both sheets show these sections, line for line.
 *
 * Plain sentences, one idea to a line, in words both apps use (what you put in, profit, pays), so neither app
 * says something the other does not. Real play's numbers come from the relayer's hello (`terms`) when it has
 * said them; before that, and in practice, from the program's defaults (`DEFAULT_TERMS`, held to
 * `state.rs` by explain.test.ts), which is what real play charges.
 */

/** The game's terms as the relayer's hello gives them: only what is explained here. */
export type ExplainTerms = {
  feeBps: number;
  profitFeeBps: number;
  holderFeeBps?: number;
  holderProfitFeeBps?: number;
  sktHalfLifeSecs?: number;
  surplusHolderBps?: number;
  minPieceStake?: string;
};

/**
 * The program's own terms (`Config::DEFAULT`, `RewardsConfig::DEFAULT` in
 * packages/contracts/solana/programs/skech/src/state.rs), and SKT's figures the hello does not carry.
 */
export const DEFAULT_TERMS = {
  feeBps: 400,
  profitFeeBps: 1000,
  holderFeeBps: 300,
  holderProfitFeeBps: 800,
  sktHalfLifeSecs: 26 * 7 * 86_400,
  surplusHolderBps: 7500,
  /** The least one piece stakes, USDC e6 (`MIN_PIECE_STAKE_E6`). */
  minPieceStake: "10000",
  /** SKT a dollar mints while the game has taken nothing yet (`SKT_PER_USDC`). */
  sktPerDollar: 100,
  /** No wallet past this share of all SKT, bps (`wallet_cap_bps`). */
  walletCapBps: 1000,
} as const;

export type HowItWorksInput = {
  /** The thirty-second paper run, practice money (a build without sign-in), or real USDC. */
  mode: "paper" | "practice" | "real";
  /** Real play's terms, from the relayer's hello; null before it has said them. */
  terms?: ExplainTerms | null;
  /** The difficulty being played: real play's is the relayer's (`hello.difficulty`). */
  difficulty: number;
  /** How far ahead ink reaches, seconds (`RULES.horizon`). */
  horizon: number;
  /** The network real play is on, as the relayer names it: "Solana devnet". */
  network?: string;
  /** Real play's USDC is test money (devnet), free from a faucet. */
  testMoney?: boolean;
  /** Where practice money is kept. */
  device: "browser" | "phone";
};

export type HowItWorksSection = { title: string; lines: string[] };

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const cents = (usd: number) => (usd < 1 ? `${Number((usd * 100).toFixed(1))}¢` : `$${Number(usd.toFixed(2))}`);

/** The line under the sheet's title. */
export function howItWorksSummary(i: Pick<HowItWorksInput, "mode" | "network">): string {
  if (i.mode === "paper") return "A free trial on paper money, on the live Bitcoin price.";
  if (i.mode === "real") return `Real USDC on ${i.network ?? "Solana"}, on the live Bitcoin price.`;
  return "Practice money, on the live Bitcoin price.";
}

/** The sheet's sections, in order. */
export function howItWorks(i: HowItWorksInput): HowItWorksSection[] {
  const t = { ...DEFAULT_TERMS, ...stripUndefined(i.terms ?? {}) };
  const real = i.mode === "real";
  const holderFee = Math.min(t.holderFeeBps, t.feeBps);
  const holderProfit = Math.min(t.holderProfitFeeBps, t.profitFeeBps);
  const weeks = Math.round(t.sktHalfLifeSecs / 604_800);
  const least = Number(t.minPieceStake) / 1e6;
  // The most a dollar of ink returns on average before the profit fee: ink exactly on a rung, or, playing for real,
  // 1 − the stake fee, past which the program refuses a band (`within_fee`).
  const most = Math.min(bestE3(i.difficulty) / 1000, real ? 1 - t.feeBps / 10_000 : 1);

  const drawing = [
    `Draw where you think Bitcoin goes over the next ${i.horizon} seconds.`,
    "Each dot of ink costs the amount under Per dot. Going back over your own ink is free.",
    "Ink is placed as you draw it, each bit on the next second.",
    "If the price crosses your ink in its second, you are paid at once.",
    "Ink the price misses is lost when its second ends.",
  ];

  const pays = [
    "The map shows what each spot pays: 1× to 128× what it cost.",
    "The multiple comes from the chance the price gets there in that second.",
    "Near the price and soon is likely and pays little. Far away pays a lot.",
    "Chances come from real Bitcoin price history, with today’s volatility and momentum.",
    "Each multiple is rounded down to a rung of one ladder: 1.1×, 1.5×, 2×, 3×, 4×, 6×, 8× and on to 128×.",
    `On average, ink returns at most ${Math.floor(most * 100 + 1e-9)}¢ per dollar${real ? ", before the profit fee" : ""}.`,
    "A wider pen puts more money on the same spots. It never changes what a spot pays.",
    "Nothing is guaranteed.",
  ];

  const faint = [
    "Only solid ink is in play. Faint ink costs nothing and pays nothing.",
    "The grey strip before the dashed line is too soon: nothing can be drawn there.",
    ...(real
      ? [
          "Ink the price is almost sure to cross can’t be placed, nor ink just under a rung.",
          "On average it would pay back more than its fee keeps, so it shows faint.",
          "Ink the game turns down fades out, and what it cost comes back.",
        ]
      : ["With real money, ink the price is almost sure to cross, or ink just under a rung, shows faint too: it can’t be placed."]),
  ];

  const fees = [
    ...(real ? [] : ["The free trial and practice have no fees. Real money has two:"]),
    `${pct(t.feeBps)} of what you put in: ${pct(holderFee)} to SKT holders, ${pct(t.feeBps - holderFee)} to skech.`,
    `${pct(t.profitFeeBps)} of the profit when you are paid: ${pct(holderProfit)} to SKT holders, ${pct(t.profitFeeBps - holderProfit)} to skech.`,
    "Payouts come from a shared pool, filled by ink the price misses.",
    "If the pool runs short, the rest is owed to you and paid first as it refills.",
  ];

  const skt = [
    ...(real ? ["Ink the price misses earns SKT."] : ["With real money, ink the price misses earns SKT."]),
    "A miss on likely ink earns more than a miss on a long shot, so every way of drawing earns alike over time.",
    `Early players earn the most: ${DEFAULT_TERMS.sktPerDollar} SKT per dollar at the start, less as the game grows.`,
    "SKT can’t be sold or sent. It is always staked.",
    `Holders share their part of every fee, and ${pct(t.surplusHolderBps)} of what the pool holds above its reserve. skech gets the other ${pct(10_000 - t.surplusHolderBps)}.`,
    "Nothing is shared while anyone is owed: what is owed is paid first.",
    `SKT halves every ${weeks} weeks. Keep playing to keep your share.`,
    `No wallet can hold more than ${pct(DEFAULT_TERMS.walletCapBps)} of all SKT.`,
    "Claim from the account menu. It is paid in USDC to your skech balance, even while play is paused.",
  ];

  const modes = [
    `Try it free: ${PAPER_MS / 1000} seconds and $${PAPER_START} of paper money, ${cents(PAPER_PER_DOT)} a dot, no fees. Nothing is sent anywhere.`,
    `Real money: sign in, add USDC, and every drawing is placed and settled on ${i.network ?? "Solana"}.`,
    `A line must cost at least ${cents(least)}. skech pays every network fee.`,
    ...(i.testMoney ? ["Its USDC is test money, free from Circle’s faucet."] : []),
    ...(i.mode === "practice" ? [`This app plays practice money, kept on this ${i.device}.`] : []),
  ];

  return [
    { title: "Drawing", lines: drawing },
    { title: "What ink pays", lines: pays },
    { title: "Faint ink", lines: faint },
    { title: "Fees", lines: fees },
    { title: "SKT", lines: skt },
    { title: "Free trial and real money", lines: modes },
  ];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}
