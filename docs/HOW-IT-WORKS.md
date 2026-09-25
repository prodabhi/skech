# How skech works

You draw ink ahead of Bitcoin's live price. Ink the price runs through pays.
Signed in, it is USDC on Solana devnet (section 11). Signed out, it is a thirty-second free trial on $10 of paper
money (`packages/core/src/paper.ts`); a build without sign-in plays $1,000 of practice money in the browser.

| Part | Where |
| --- | --- |
| The screen | `ui/app/src/components/app/ink/` |
| The live price | `packages/engine` (Rust), read by `ui/app/src/lib/engine.ts` |
| The game on chain | `packages/contracts/solana/programs/skech/src/` (Anchor, on Solana) |
| Pricing and sending pieces to the chain | `packages/relayer` (Bun) |
| What the app signs, and the ladder in integers | `packages/core/src/chain.ts` |
| How it works, as the apps say it | `packages/core/src/explain.ts` |
| The browser's drawing key, the relayer, real money on screen | `ui/app/src/lib/session.ts`, `lib/relayer.ts`, `components/app/ink/chain-context.tsx` |
| Practice balance and settings | `ui/app/src/lib/practice.ts` |
| Market readings, price paths, chances | `packages/core/src/dots.ts` |
| Drawings: cost, opening, settlement | `packages/core/src/ink.ts`, `ink-area.ts` |
| Quotes while drawing | `packages/core/src/odds.ts` |
| Price history | `packages/core/scripts/fetch-coinbase.ts` |
| Replay check | `packages/core/scripts/check-ink-area.ts` |

The page, the replay and the tests run the same functions from `packages/core`.
Nothing is priced twice.

## 1. The price

- Coinbase BTC-USD, trade by trade, over its public WebSocket (`matches`), through the engine (`packages/engine`).
  The browser talks only to the engine.
- The engine keeps the last ten minutes of trades, backfilled from Coinbase's REST API when it starts,
  and sends them to the app on connect to seed the chart.
- Each live trade comes signed by the engine's wallet as EIP-712 typed data, under one fixed domain, so the
  relayer can check the price a piece was drawn at before it places it (`packages/engine/src/quote.rs`).
- The engine passes on Coinbase's heartbeat every second. Five seconds with no message at all and the socket is reopened.
- Each trade is folded into the bar of its second: high, low, close.
- A second with no trade is closed at the last price once it is 600 ms old.
- The chart line is drawn from the trades themselves, with no smoothing delay.

## 2. Reading the market

At each whole second the game reads four things from the bars before it (`features`):

| Reading | What it is |
| --- | --- |
| `price` | the last close |
| `sigma` | how busy the market is: five-second moves over the last five minutes |
| `momentum` | the last three seconds' move, in units of `sigma` |
| `wick` | how far the price swings inside a second, beyond close-to-close |

The **market step** is 2.5 typical one-second moves, rounded to a round dollar
figure (`stepFor`). On every screen the chart shows 6.75 market steps top to
bottom (`VIEW_STEPS`: nine, zoomed in by 10/7.5) and 16.5 seconds ahead of now (`drawingLayout`, `VIEW_SECONDS` = 15). Ink can be
bet up to 30 seconds ahead; the view shows the nearer half, stretched, so it moves fast. The pen stops at the chart's
top and bottom edges.

## 3. What you draw

- A pen is a round nib: 8, 14 or 20 CSS pixels (Fine, Medium, Wide).
- A stroke is the nib swept along your path: round caps, round joins.
- Its **area** is measured in dots. One dot is one full nib tap: `A = π · rt · rp`,
  where `rt` and `rp` are the nib's radius in time and price.
- Area is integrated in 2-pixel price slices, 24 samples per second.
- Going back over your own ink in one drawing costs nothing extra.
- A tap entirely in play is exactly one dot, however it lines up.

**Cost** = your per-dot amount × area, rounded up to the cent once per drawing.

Ink is bet **as it is drawn**, not when the pen lifts. About every 150 ms while the
pen is down, the ink added since the last piece (`newInk`) opens on the next second,
priced on what is known then (`placeInk`). A slow stroke is not priced on where the
market has gone by the time it ends. The pieces add up to exactly the whole stroke's
area, and the drawing's stake rounds up to the cent once over all of them: each piece
takes the growth of that rounded total. Payouts round once per drawing the same way.

## 4. Sections

Each second of a drawing is cut into **sections** of about two dots or less,
each a continuous band of price. A section pays once if the price reaches any
part of it.

- Two CSS pixels of tolerance are added above and below every section.
- Its chance is priced with the same tolerance.
- No section is taller than the widest pen draws: 64 grid units, the wide pen at the smallest chart (6750 / 120
  = 56.25 units) with room over (`MAX_SECTION_WIDTH`). A steep stroke's sliver of a second can cover a tall band with
  almost no area; it is cut into bands no taller than that. The relayer and the program refuse a taller one: a band
  over the whole map at second 1 is all but certain.

## 5. The chance

The chance is measured, not modelled.

- The library: 16,000 real 30-second stretches of Coinbase BTC-USD, 1–16 September 2026,
  folded into one-second bars the same way the live feed folds them.
- Each stretch is weighted by how like now it started: as busy, moving the same way.
  The match widens until at least 1,500 effective paths count.
- Each path's in-second swings are scaled to how much the price swings inside a second now.
- A section's chance is the weighted share of paths whose second reached its band:
  `P(low ≤ top) − P(high < bottom)`.

A section in second `t` is reached if that second's range, counted from the
previous close to its own high and low, overlaps the padded band. Live
judging uses the same rule on live bars.

### Why the chance is measured

A formula was fitted (`scripts/odds-formula.ts`) and tested on a week it never saw.
Ordinary players got back 45–75¢ a dollar. A bot that drew only where the formula
was generous got back up to $1.21. Bitcoin sits on its tick, jumps, and keeps going
after a jump; a smooth formula gets each of those wrong somewhere a player can find.

## 6. What a section pays (`ladder-v1`)

Every piece of ink pays a rung of one ladder, per dollar of ink:

```
LADDER = 1.1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128 (×)
fair   = (ladderBest − momentum margin) / p
rung   = the highest rung ≤ fair, or 128× past it; under the floor, fair itself,
         rounded down to the hundredth, and never under 1×
hit pays d × stake × rung                  (one section pays at most 256 dots)
```

- **Difficulty** is one number, 50 to 100 (`DIFFICULTY` in `dots.ts`, 55 by default;
  a slider in the help sheet in development, or with `?house`). Real play and the free trial use the market's
  setting on chain, which the relayer's hello carries: 51 on devnet. It sets `ladderBest`,
  what ink exactly on a rung returns: 1.20 − 0.40 × d/100, so 98¢ at 55. Under 50 that
  is more than a dollar, so both chains refuse a lower setting (`MIN_DIFFICULTY`), and
  price one set lower before there was a least as 50. It also sets the floor, the least
  a rung pays: 1.1× up to 70, easing to 1× at 100. Harder lowers every rung a spot earns;
  nothing ever pays under 1×.
- A section's chance `p` sets its rung. Ink placed exactly on a rung returns
  `ladderBest` per dollar. Everywhere between rungs rounds down, by at most a third, and 15% on average.
  Rungs double, with one between each pair, so the loss stays small.
- Only ink the price actually crosses pays.
- A band is never priced as likelier than one nearer the price. Far out, a band's chance
  rests on a few library paths, and a handful that ended together once made 12×, 8×, 12×
  alternate a few pixels apart. Each second, chances are held to fall away from the
  likeliest price (`fallingChances` in `dots.ts`), which only ever lowers a payout.
- On the side the price has just moved toward, fair is lowered by 0.11 × momentum,
  at most two units.
- Ink too likely for the floor pays its fair multiple, rounded down to the hundredth, and
  never under 1×: 99% likely at 55 pays 1× (99¢ back), 90% pays 1.08×. So no stroke is
  cut, and at every chance and difficulty a band returns at most a dollar per dollar before
  fees (chance × rung ≤ 1, tested exhaustively in `chain.test.ts` and fuzzed on chain).
- Ink worth more than 128× pays 128×, so the farthest ink returns less than the rest.

The map shows three columns of numbers, each doubling rung (2×, 4× … 128×) once per
side in the middle of its band, plus what the price's own band pays. Under them a soft
glow, sampled from the same quotes, is dark on the price and brightens, blue toward
white, as the rung climbs. Numbers and glow re-price each second and cross-fade rather than snap.

### Why every screen and pen returns the same

A rung depends only on a section's chance, and a chance depends only on where the
ink is in price and time. The pen and the screen change how much ink goes where,
never the rung a given chance earns.

### Time

On the price line the rung rises with time: about 1× a few seconds out, 4× at 30
seconds, because the price has longer to wander off. At the edge it falls with
time: a far level is out of reach in 5 seconds but not in 30.

### Why far rungs come close to the price

A dot is small and pays only in its own second. Even one row off the price, a
dot's exact second touches it only about 1 time in 30. Bitcoin second to second
mostly sits still and then jumps, so far rows are touched more often than a smooth
curve would say, and the multiples climb slowly rather than exponentially.

The chances themselves were checked against what happened, before the ladder rounded
them: 123,000 single taps over a laptop-sized map, Binance September 17–24, Medium pen,
grouped by the continuous multiple they were quoted:

| Quoted | Actually hit | Priced at | Paid back per $1 |
| --- | --- | --- | --- |
| under 2× | 13.0% | 14.6% | 0.64 |
| 2–5× | 7.9% | 8.5% | 0.67 |
| 5–10× | 6.4% | 6.5% | 0.70 |
| 10–20× | 4.2% | 4.3% | 0.70 |
| 20–30× | 2.8% | 2.6% | 0.77 |
| 30–50× | 1.7% | 1.7% | 0.73 |
| 50–100× | 0.9% | 0.8% | 0.75 |

### Zoom

The chart shows 6.75 market steps top to bottom (it showed nine until September 28). Zooming in moves the edge closer to
the price (lower edge multiples) but makes the same pen cover less price (higher
multiples everywhere else), so the map gets flatter rather than just shorter. On a
laptop, a tap's quote by zoom (columns: 5, 17 and 29 seconds ahead):

| Market steps in view | On the price | Halfway to the edge | At the edge |
| --- | --- | --- | --- |
| 3 | 1.5× / 3.3× / 5.4× | 12.7× / 13.9× / 16.1× | 24.7× / 18.4× / 20.3× |
| 6 | 1.4× / 2.8× / 4.3× | 14.8× / 10.9× / 12.1× | 72.8× / 30.5× / 22.0× |
| 9 (until September 28) | 1.3× / 2.4× / 3.6× | 24.1× / 12.2× / 10.4× | 92.9× / 57.5× / 35.8× |

## 7. Timing

- Each piece of ink opens on the next whole second and is priced there, on everything
  known by then.
- The second after opening is never in play, so nobody can react faster than the bet.
  So ink starts counting one to two seconds ahead. The wait line holds still at two
  seconds: everything right of it always counts, and the zone left of it is greyed out
  and cannot be drawn in.
- Ink reaches 30 seconds ahead of the opening second.
- The preview uses the last closed second's map; the opening uses its own second's.
  If a section is no longer offered at opening, its stake is refunded.
- A hit pays the moment the price reaches it and glows green. A miss settles once its
  second closes and turns red as the price passes.

## 8. Live P&L

- Placing a drawing takes its cost from the balance at once.
- Live P&L is payouts received minus the cost of ink that has settled. Pending ink
  is not counted as a loss.
- When a batch of drawings finishes, its result stays as Last P&L.

## 9. The replay

`check-ink-area.ts` replays days the library never saw. It uses the page's own
layout, preview, opening, refunds and settlement, at ten screen sizes, three pens
and five drawing styles: a random tap, a level line, with momentum, against it,
and `on-price`, ink only on the live price in the first seconds.

```bash
STEP=600 OUT=report.json bun packages/core/scripts/check-ink-area.ts \
  packages/core/src/dots-lib.bin <csv folder> 2026-09-17 2026-09-18 …
```

These figures predate the rule that near-certain ink pays its fair multiple, not the floor:
`on-price`, and a little of every other row, will come in lower when the replay is run again.

Coinbase BTC-USD, September 17–24, library from September 1–16, at difficulty 70
(ladder best 92¢): 172,777 drawings opened, 8,047,900 invariant checks passed. At the
default 55 (best 98¢), with chances held to fall away from the price, the same replay returns 0.779 overall (95%: 0.729–0.832), 0.777–0.783 by screen and 0.779–0.780 by pen; drawing with the momentum returns 0.876 (95%: 0.789–0.975). Before that rule it was 0.798 at 55; at 60 0.781, at 75 0.730. At 66
(best 93.6¢), 172,800 drawings, 11,338,664 invariant checks passed: 0.744 overall
(95%: 0.695–0.795), 0.741–0.748 by screen, 0.744 for every pen; level line 0.695,
against momentum 0.710, with momentum 0.839, `on-price` 0.859.
The replay places each drawing whole; pieces bet as they are drawn price each piece
the same way.

| | Got back per $1 | Model |
| --- | --- | --- |
| Every screen, phone to 1440p | 0.738–0.754 | 0.756–0.759 |
| Every pen, Fine / Medium / Wide | 0.750 / 0.743 / 0.740 | 0.756–0.758 |
| Level line / against momentum | 0.703 / 0.709 | 0.755 / 0.769 |
| With momentum | 0.830 | 0.741 |
| `on-price` | 0.876 | 0.792 |
| **All** | **0.746** (95%: 0.698–0.796) | **0.757** |

Drawing with the last three seconds' move returns more than the model expects on
Coinbase (0.83 against 0.74): the momentum margin, tuned on Binance, is too small here.

By rung, single taps spread over a laptop map, with the best at 90¢ (73¢ overall):

| Rung | 1.1× | 1.5× | 2× | 3× | 4× | 6× | 8× | 12× | 16× | 24× | 32× | 48× | 64× | 96× | 128× |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hit rate | 68% | 49% | 34% | 24% | 17% | 12% | 9% | 6.6% | 4.8% | 3.1% | 2.4% | 1.7% | 1.1% | 0.8% | 0.4% |
| Per $1 | 0.74 | 0.73 | 0.69 | 0.72 | 0.69 | 0.75 | 0.71 | 0.78 | 0.79 | 0.77 | 0.79 | 0.78 | 0.72 | 0.80 | 0.55 |

Ten single taps in a row: median 30¢ back, 39% lose everything, the luckiest 10%
get $1.85 or more. How much a session swings depends on the rung drawn on, not the
formula: ten $1 taps land between 50¢ and $1.25 only on the lowest rungs.

Five fixed drawing styles are not a search for every exploit. The replay has no
network latency. Model agreement does not guarantee future returns.

### The paper run

Signed out, "Try it free" plays thirty seconds on $10 of paper money (`paper.ts`):
the live price, the real screen, nothing sent to the relayer, no fees, a cent a dot,
and a "Practice" pill the whole time. It plays the real game's odds: the live game's
difficulty when the relayer has said it, else the game's own. A practice run that paid
more than the real game would sell one that isn't there.

`check-paper.ts` replays six strokes drawn near the price (a level line within a
market step, with and against the move, along the price, from the price drifting
off, a zigzag across it) on three screens and three pens at 10¢ a dot. Coinbase
BTC-USD, October 7–9, 46,494 drawings per level:

| Difficulty | Best ink | Touched | Came out ahead | Per $1 |
| --- | --- | --- | --- | --- |
| **55 (real, and paper)** | **0.98** | **59.7%** | **28.6%** | **0.783** |
| 50 | 1.00 | 59.7% | 29.1% | 0.799 |
| 25 | 1.10 | 59.7% | 31.2% | 0.880 |
| 0 | 1.20 | 59.7% | 33.0% | 0.961 |
| −50 | 1.40 | 59.7% | 36.0% | 1.122 |
| −100 | 1.60 | 59.7% | 38.4% | 1.286 |

Whether the price touches a stroke does not depend on the difficulty: 74–79% of
strokes along, from or across the price are touched, 51% of level lines, 38–40% of
diagonal ones. The difficulty only moves what a touch pays, so it cannot raise the
hit rate, and even a giveaway does not make most rounds come out ahead.

## 10. Rebuilding

```bash
# Coinbase trades, folded into one-second bars, one CSV per UTC day (about a minute a day)
bun packages/core/scripts/fetch-coinbase.ts <csv folder> 2026-09-01 … 2026-09-24

# the path library
bun packages/core/scripts/build-dots-lib.ts <csv folder> packages/core/src/dots-lib.bin 2026-09-01 … 2026-09-16
cp packages/core/src/dots-lib.bin ui/app/public/dots-lib.bin   # a test checks the two match

# tests
cd packages/core && bun test
```

## Saved drawings

Drawings saved in a browser under earlier terms (`area-v1`, `rounded-v1` to `rounded-v3`, `fair-v1`,
and the original per-row points) keep the terms they opened on. `ink.ts` never
reprices a saved drawing.

## 11. On chain

Signed in, with a game deployed on the cluster `SKECH_SOLANA_CLUSTER` names (devnet for now), the same
drawing is played for USDC on Solana. On devnet the USDC is free from Circle's faucet, and the app says
so where it asks for a deposit. Nothing about the pricing changes; what changes is who vouches for what.

### The grid

Ink is priced and judged on a grid of the market step: one unit is the step over 50 (20¢ on a $10
step), bands sit on it, and every band is judged one unit wider each way (`gridStep`, `unitFor` in
`chain.ts`). The screen sets only the pen's size. So a phone and a 1440p screen price the same ink
the same, and the chain judges exactly what was priced. The replay (`check-ink-area.ts`) runs on the
same grid.

### The program

One Anchor program, `skech` (`packages/contracts/solana`; its README has the details). Its accounts are
all addresses of the program:

- **`Game`** holds the terms, the oracle and the USDC vault. The house never holds the players' money.
- **`Pool`**: every stake goes into one pool, and every hit is paid from it. The house's take is counted
  here too: a share of every stake as it is placed, and of the profit on every hit, both the admin's to
  set (`set_config`): 4% of every stake and 10% of every profit. Of those, 3 of the 4 points and 8 of the 10 go to SKT holders
  (below), 1 and 2 to the treasury; `collect_fees` moves the treasury's out. What the pool holds over a reserve
  and over what every live bet could pay goes 75% to SKT holders and 25% to the treasury (`share_surplus`, below).
  Nothing else.
- **`Market`** and **`Bars`**: each market's difficulty, and a ring of its last 240 seconds of price. The
  ladder is computed in the program (`ladder.rs`, the same integers as `chain.ts`, checked row for row
  against `@skech/core`), so the oracle cannot pay a band more than its chance earns at the difficulty on
  chain.
- **`Player`**, one per wallet: its USDC balance, its session key, and the IOUs it holds. An IOU is what the
  game owes when the pool cannot pay a hit at once: shares worth one USDC when they started and rising at a
  fixed rate, carrying their basis, what was owed when they were issued. Anyone may hand a holder's shares
  back once the pool can pay (`redeem`), and is paid 10% of the growth for it; a holder redeeming their own
  pays nothing. The house is never owed: its 10% of a profit is taken after the player is paid, from what
  the pool has left, and goes without the rest.
- **`Bet`**, one per piece: its bands until each is decided, and after them each band's chance as the oracle
  quoted it, for SKT. It is then closed, its rent back to the relayer.
- **`Rewards`** (one) and **`Holder`** (one per player): SKT, below.

The EVM contracts the game was first written as (`packages/contracts/evm`) are kept in the repo, not
deployed or used; the conformance cases (`packages/contracts/conformance`) still play both, so the two agree
on every payout, fee, refund and refusal.

### What goes on chain, and who signs it

| Thing | Signed by | Says |
| --- | --- | --- |
| A **piece** of a drawing | the player's session key (Ed25519, checked by the Ed25519 precompile over the piece as it sits in `place`) | the bands (second, price from, width, on the grid), what each stakes, what a dot costs, the second it opens on, the price on the screen and when, the difficulty shown, the stroke's hash |
| A **quote** | the oracle (the relayer's key), by signing the `place` transaction | when the piece was received, the market's price and momentum then, and each band's chance in billionths |
| A **price** | the engine, as EIP-712 typed data | the price the player saw, as the engine already signs every trade; the relayer checks it before it places the piece |
| A **bar** | the oracle, by signing the transaction | one second of the price: the close before it, its high, low and close |

The chance is measured off chain, on the paths, as before; it cannot be measured on chain. The
rung is computed on chain from the chance, the difficulty and the momentum. Each piece is its own
`place` transaction: transactions that write different accounts run in parallel, and a placement writes
only the player's account, their new bet and the pool. A piece that cannot go in fails with its reason.
`post_bar_and_settle` records a second's bar with the first dozen bets that have ink in it, and the rest
settle on it in parallel: a band is hit if the second's range, from the close before to its high and low,
reaches it, one unit wider each way, the rule of section 5.

### Timing, and why it cannot be gamed

- A piece must reach the relayer before its opening second, give or take 200 ms (`late_ms`, on
  chain); the oracle vouches for when it received it, and the program refuses anything later. The app
  computes the opening second from `now + 200 ms`, so a piece drawn at the end of a second opens on
  the one after and is never late.
- The `place` transaction must land within 3 s of the opening second (`place_grace_ms`); a band
  whose second is already posted is refused and its stake not taken.
- The price a player saw must be no older than 15 s and no newer than the receipt.
- A bar may be posted up to 200 s after its second. A band whose second was never posted by then is given
  back in full by `expire`, which anyone may send.
- A piece is named by its player, drawing and index, and its bet lives at the one address that names: sent
  twice, it is refused as a replay.
- A piece is signed under the game's domain (SHA-256 of `skech/v1`, the program id and the cluster), so
  nothing signed for one deployment or cluster verifies on another.

### Sessions

A session key signs pieces; nothing else. It is an Ed25519 key the app keeps on the device. Registering it,
an expiry and an allowance of stake, is one transaction the wallet signs and the relayer pays for (the relayer
builds it, the wallet signs, the relayer sends exactly what it built); drawing then takes no prompts at all.
A session cannot withdraw: withdrawals need the wallet. Deposits are a `deposit` the wallet signs, or a `sweep`
on a standing approval, so USDC that lands in the player's wallet is moved in by itself and a player sees one
address and one balance. Players never hold SOL: the relayer pays every fee and every rent.

### The relayer

`packages/relayer`: checks each piece as it arrives (the session's signature, the engine's price, the
balance), prices it with `@skech/core` on the map of the opening second, 350 ms into it, and sends it in its
own `place`, signed as fee payer and oracle. When a second ends it posts the bar and settles the bets with
ink in it. Every five minutes, when nothing is due, it redeems IOUs the pool can pay, sweeps in USDC from
wallets that approved it, and collects the fees. Compute limits come from
`packages/contracts/solana/snapshots/compute.json`, measured in LiteSVM; the priority fee follows what recent
blocks paid to write the pool, capped; every request to the RPC waits on one budget, sends first. Its README
has the rest.

A piece must stake at least 1¢ (`MIN_PIECE_STAKE_E6`, `SOLANA_MIN_PIECE_STAKE`), as it arrives and after
what the program would hand back, so a single dot goes in. Each piece is a transaction the relayer pays for,
about 7,100 lamports with its share of settling (about $0.0008), and only the treasury's point of the stake fee
pays that back: 1% of 10¢ does, 1% of 1¢ does not. So the apps hold ink back while the pen is down, drawn as it is, and send a line
in pieces of about 10¢ (`BATCH_PIECE_STAKE_E6`), keeping at least 1¢ back for its end, which goes as a piece
of its own when the pen lifts; a whole line under 1¢ is not sent ("Draw a little more"). Pieces under 10¢ are
limited for each player instead of refused, 10 at once and 2 a second, so ink drawn in crumbs (near-certain
ink returns about 99¢) cannot cost the game more than a little. Paper and practice runs send nothing and are
not held.

The apps play the player's own ink as placed from the moment it is drawn (`packages/core/src/optimistic.ts`):
held-back and in-flight ink looks exactly like confirmed ink, its stake leaves the balance at once, and each
piece opens on the screen as the chain will open it and is judged on the local price, hits paid, heard and felt
at once. Each stake and hit is held in the balance under the piece's name until the chain has done it and its
next word on the balance includes it. `placed` swaps in the chain's bands (keeping what the price already did
to them) and repays any difference; a settlement that disagrees moves the balance to the chain's figure. A piece
refused by the relayer, voided, given back (`expiredMask`) or not placed within 8 s fades out over 300 ms, its
stake comes back and its hits are taken back, and one quiet notice covers a burst of them. A drawing's round
card waits until every piece of it has been taken or refused.

### Fees and the pool, by the numbers

On chain a band is offered only if it leaves the house its stake fee in expectation: chance × multiple, what it
returns per dollar before fees, at most 1 − the fee, 0.96 at 4% (`within_fee` in `ladder.rs`, `withinFee` in
`chain.ts`; the apps grey such ink out). Ink that returns more, certain ink at 1× or ink exactly on a rung at a low
difficulty (chance × rung is 1.2 − 0.4 · d/100 there: 1.0 at 50, 0.98 at 55, 0.96 at 60), would let a player put
money through the pool at no risk while the holders' share of its fee came out of the pool. At difficulty 55 that
drops ink within 2% under a rung; at 51, devnet's setting, within 3.6%. At both it drops all ink over 87% likely
(0.96 / 1.1): just under the first rung, or so likely it pays its fair multiple under the floor.

A half-dot at 10¢ with a 50% chance at difficulty 51, with the 4% stake fee: fair 1.992×, rung 1.5×, and
0.5 × 1.5 = 0.75, under 0.96, so it is offered. Placed: 5¢ leaves the balance, 0.2¢ (4%) is fees (0.15¢ to SKT
holders, 0.05¢ to the treasury), 4.8¢ joins the pool. Hit: 7.5¢ gross, 2.5¢ profit, 0.25¢ (10%) fees (0.2¢ to
holders, 0.05¢ to the treasury), 7.25¢ to the balance, paid from the pool. Missed: the 4.8¢ stays in the pool for
the next hit, and the miss mints SKT on 5¢ · [(1 − 0.75) + 0.1 · 0.5 · 0.5] / 0.5 = 2.75¢ (2.75 SKT at G = 0).
With the pool empty, the 7.25¢ is owed as IOU and paid off as others lose; while it is owed, the holders' share of
every fee goes to the pool to pay it, and no surplus is shared.

### SKT

SKT is what losing earns back: a share of the fees and of the pool's surplus. It is never sold, sent or unstaked,
and it halves every 26 weeks. It is an internal balance on the player's own `Holder` account
(`packages/contracts/solana/programs/skech/src/skt.rs`), counted in millionths like USDC, and every unit of it, as it
stands today, earns the same part of every holder's share. The apps show the
balance and what it has earned in the account menu, with Claim, and a quiet "+120 SKT" after a round that
came out behind.

**What mints.** Every band that misses mints at its settlement, on its *basis*:

    basis = stake · [(1 − p·m) + f·p·(m − 1)] / (1 − p),  at least 0 and at most the stake

where `p` is the chance the oracle quoted for the band (kept on the bet), `m` the multiple it was placed at and `f`
the profit fee (10%). A hit mints nothing; a band given back by `expire` mints nothing; a bet placed before SKT mints
nothing. In expectation a band's basis is `stake · [(1 − p·m) + f·p·(m − 1)]`, exactly what it can expect to lose,
the profit fee a hit pays included, whatever its odds. So no way of drawing mints more SKT per dollar it can expect
to lose:

| | stake | expected loss | a miss counts | how often | expected basis |
| --- | --- | --- | --- | --- | --- |
| a 1% long shot at 96× | $1 | 1 − 0.96 + 0.1 · 0.01 · 95 = 13.5¢ | 13.5¢ / 0.99 = 13.6¢ | 99 in 100 | 13.5¢ |
| ink at 48% paying 2× | $1 | 1 − 0.96 + 0.1 · 0.48 · 1 = 8.8¢ | 8.8¢ / 0.52 = 16.9¢ | 52 in 100 | 8.8¢ |

A long shot's misses are many and small; near-certain ink's are rare and large; per expected dollar lost they
come out the same. In the program's tests, 1,500 long shots and 6,000 pieces of ink at 50%, each strategy
expecting to lose $15, minted within a few percent of each other (`a_long_shot_mints_no_more_skt…`). On 15 days of real
bands at difficulty 51 (the audit's farm table), basis per real dollar lost was 0.55 for long shots, 0.17 for ink just
under a rung and 0.96 on the floor rung before the profit fee was counted; counted, it is 0.80, 0.69 and 1.01, the
middle rungs 1.05, and every strategy's 95% interval reaches 1 or under: about 100 SKT per real dollar lost at G = 0
at most. What remains below 1 is the oracle's chance running a little high on long shots, so they lose more than they
were quoted to.

The stake fee is not added to the basis. A hit pays its multiple on the whole stake, fee included, so the fee is
taken from the pool's side and is already inside `stake · (1 − p·m)`: ink that is certain to hit at 1× loses
nothing (the house's 4% comes out of the pool), and adding the fee would mint on it. A loss that would only
shrink an IOU the player is owed cannot happen here: every stake comes from the player's USDC balance, never
from an IOU.

**How much.** A settlement's basis `B` mints at a rate that falls as the game's tracked gain `G` grows:

    rate(G) = 100 · (S / (S + G))²  SKT per $1 of basis
    minted  = ∫ from G to G + B of rate = 100 · S² · B / ((S + G)(S + G + B))

`G` is every basis minted on so far (`Rewards::gain`): what players have lost to the game, in expectation. What is
owed as IOU changes nothing about the mint: an earlier version minted from 0 while anything was owed, which let a
dust IOU reset the curve for a whale's whole loss. `S` is the
admin's (`mint_scale`, default $1,000,000), so the rate falls across a gain of $0 to $10M:

| tracked gain G | $0 | $100k | $500k | $1M | $3M | $10M |
| --- | --- | --- | --- | --- | --- | --- |
| SKT per $1 of basis | 100 | 82.6 | 44.4 | 25 | 6.25 | 0.83 |

Minting the integral rather than the rate at `G` means one basis of `B` and two of `B/2` mint the same, to the unit,
and the whole curve is worth `100 · S` SKT to everyone together, however much is lost. Integers throughout, in
u128: the first term rounded down and the second up, so never more than the exact integral.

**What it earns.** Of the 4% stake fee, 3 points go to SKT holders and 1 to the treasury; of the 10% profit fee, 8
and 2 (`holder_fee_bps`, `holder_profit_fee_bps`, each at most its fee). The house keeps every rounding. The
holders' share is added to an accumulator, `acc += share · 10²⁴ / counted`, and a holder has earned
`shares · (acc − acc_at) / 10²⁴`, counted into `unclaimed` before their shares change, rounded down (through 256
bits); what is set aside for a share is rounded up, so the holders' parts never pass it. Two exceptions, as
Papertrade has them: while anything is owed as IOU, the holders' share goes to the pool to pay it off (IOUs come
first); while there is (next to) no SKT, it goes to the treasury. The treasury's profit cut, and the holders', come
out of what the pool has left after paying the player, and are never owed. `claim` pays what a holder has earned into
their balance, as a hit's winnings are paid, paused or not, as a withdrawal is; a claim with nothing to pay is refused,
so nobody pays a fee to move nothing (the relayer never builds one).

**The pool's surplus.** The pool pays every hit, and the house's edge stays in it: nothing else ever took it out.
`share_surplus` (anyone may send it; the relayer does on its five-minute sweep, once there is $10 to share) moves what
the pool holds over **the reserve plus the most every live bet could pay** out of it: `surplus_holder_bps` of it (75%,
rounded down) into the holders' accumulator, as a fee's share is, and the rest (25%, the rounding with it) to the
treasury. The admin may set the split anywhere from 0 to 10,000 bps. Every placement adds what its bands could pay if every one hit to `Rewards::liability`, and every settlement
takes away what it decides, so after a share the pool still holds every live band's worst plus the reserve. It never
runs while anything is owed as IOU (or to the house), nor in the first four minutes after SKT starts, while bets placed
before it (not counted) can still be decided. The reserve (`surplus_reserve`) is the admin's, never under the most one
piece can pay at the game's terms (`max_piece_payout`: 32 bands of 256 dots at the dearest dot, or the largest stake at
128×, whichever is less), and by default three times that: $2,457,600 at the default terms ($819,200 = 32 · 256 ·
$100). Live bets are already covered by the liability, pieces arriving in the same second included (each adds its stake
to the pool and its worst to the liability together); the reserve is for the swing between one share and the next.

**Decay.** SKT halves every half-life (`half_life_secs`: 26 weeks by default, 4 weeks to 10 years). Every balance
decaying alike would change nobody's share, so decay is kept as weights: a mint of `skt` at time `t` adds
`skt · 2^(t/h)` shares, a holder's SKT now is `shares · 2^(−t/h)`, and holders are paid by shares, which is by today's
balance. So the first players still get the most SKT per dollar, but an early loss earns less and less beside newer
ones: a player keeps their share by playing on. The apps show the balance as it is now, decayed. The weight is counted
from the era's start, between 1 and 2^16; at each era's end (16 half-lives) every share is divided by 2^16, the total at
once and each holder's when it is next touched, the accumulator starts again from 0, and the last eight eras' closing
values are kept, so a holder away for up to eight eras (64 years at the default, 10 at the shortest half-life) is paid
everything their shares earned; one away longer loses what they earned in the era they were last seen in, which stays
in the holders' funds, never anyone else's. The weight is an exact fixed-point `2^x` (a table of 32 roots of 2, shared
with the conformance reference), shares stay under 2^75 at the largest scale, and the program's tests jump 60 years
(and a century) without overflow, paying nobody more than was set aside. A new half-life applies from the moment it is
set: no weight jumps.

**The cap.** No mint takes a wallet past 10% of all shares (`wallet_cap_bps`), or past 10% of the floor while there is
little SKT, whichever is more; what would pass it is not minted, though the tracked gain moves on by the whole basis.
The floor (`cap_floor`, 1M SKT) is SKT as if minted when SKT started and held by nobody: it decays as every SKT does,
so it lets the first players mint (up to 100,000 SKT each) and then fades. And every share is counted against the
larger of all shares and the floor's: what a wallet is paid is at most 10% of anything shared, its own fees and losses
coming back to it through the pool included; what the floor keeps from holders goes to the treasury. One check per mint and per share. It does not stop a player with many wallets: a sybil whale is
capped at 10% per wallet, not in all.

**Invariants**, checked after every step of random games in the program's tests:

- the vault holds exactly every balance, the pool, the treasury's uncollected fees and the holders' funds;
- everything claimed and claimable is at most everything accrued to holders; the holders' shares never add up to
  more than the total;
- a player's SKT is at most 100 per dollar of their basis, and their basis at most the stakes they lost;
- `G` is every basis; the pool keeps the reserve and the liability through every share of its surplus.

**Accounts.** `Rewards` (seeds `"rewards"`, 319 bytes) holds the shares, the accumulator and the last eras' ends, the
holders' funds, `G`, the decay's clock, the live bets' liability and SKT's terms. `Holder` (seeds `"holder"`, the
wallet, 141 bytes) holds a player's shares and their era, what they have earned, their basis and every SKT minted to
them; the first settlement that mints for them opens it, the relayer paying its rent (about 0.0019 SOL), so no account
is made for anyone who never loses: a hit, a refund or a close opens nothing, and sybils that never lose cost the
relayer no rent. Settling takes each bet as (bet, player, holder), nine to a transaction. Until `init_rewards` has run
(after the upgrade that brings SKT), nothing is placed, but bets live across the upgrade still settle and expire
without it, minting nothing (`load_rewards`). `mint_scale` is fixed once anything has minted: every SKT and `G` are on
the old scale's curve, and a new scale would mint the next dollar as if the curve had always been the new one.

**What the audits' attacks come to now** (`packages/contracts/solana/tests/src/audit.rs`, and the economic replays):

- Certain ink is refused: no band over 64 units, none past the fee. The cheapest ink left to churn, a 64-unit band
  at the price at second 1, costs the churner 9.8¢ a dollar, and holders all together get 8.8¢ of it (the treasury
  1¢): churning costs more than any holder gains, even one holding everything, and with the cap a wallet gets at most
  10% of it.
- A dust IOU changes nothing: the mint is the curve's integral from `G`, IOUs or not, and splitting a loss mints the
  same.
- A whale that keeps itself at the cap, losing every day on its best strategy as others play, never gets back what it
  loses: over one to five years at $100k to $10M a day it gets back 0.64 to 0.82 when others play near the price, 0.76
  to 0.85 when they play everything offered, and 0.79 to 0.95 when they play mostly long shots (whose quoted chance
  runs a little high, so they lose more than their basis); the worst case found is 0.955, long shots at $3M a day for
  five years. Holders are paid (loss − treasury) per dollar of others' basis; with all of the surplus to holders that
  came to over a dollar against long shots (1.13 to 1.17 back), and the treasury's quarter of the surplus is what
  brings it under. At most about 8% of a capped whale's cost comes back from its own play. Holders take about 0.21 a
  dollar staked near the price once the pool is over its reserve (0.26 against long shots, 0.42 everything offered),
  and the treasury about 0.067 (0.082, 0.138).
- A whale losing early, at G = 0, mints at most 100,000 SKT (10% of the floor), for $961 of real loss; beyond that an
  early loss mints nothing until others hold SKT. Those first 100,000 SKT are the curve's early rate at work, not the
  cap failing: they pay many times their cost if the game grows (8× in a year at $100k a day), while $100k lost early
  gets back 0.09 in a year at $100k a day and 0.96 at $1M.
- Decay and the curve together: at $1M a day near the price, players who lost in the first year hold 97% of all SKT
  (decayed) after two years, 84% after four and 47% after six: with S = $1M the curve falls faster than a 26-week
  half-life for the first years, and decay wins after.

### Running it

```bash
bun run deploy:solana                    # the program on devnet, from .env.local; writes deployments/solana-devnet.json
bun run dev                              # engine, relayer, app, landing
bun packages/relayer/scripts/e2e-solana.ts   # the whole game on a local validator, with a scripted player
bun run solana:test                      # in packages/contracts: the program in LiteSVM, every attack refused among it
```

## Before mainnet

- Retrain the library on recent days, and watch live hit rates against priced ones.
- Give the admin and the program's upgrade authority to a multisig, apart from the oracle's key on the box.
- Watch the pool: IOUs are the plan for a shortfall, not for a run.
- Get legal advice: this is a fixed-odds bet on a price.
