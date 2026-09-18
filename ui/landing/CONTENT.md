# Landing page content spec

The source of truth for what skech.trade's landing page says and in what order.
Copy in this file is meant to be pasted into components, not paraphrased. If the
page and this file disagree, this file is wrong — fix it here first.

Status: a full copy pass has been run over every section on the page. No
banned term from §4 renders anywhere; the only survivors are `perpetuals` and
`perps` in the SEO keywords meta, which no reader sees and which are the terms
people actually search. `Thesis`, `WhatItSets`, `TradePanel` and `TradeChart`
are cut. §5.4 (Both numbers), §5.5 (Show your call) and §5.6 (Trust strip) are
still unbuilt.

---

## 1. The shift

The page we have is written for someone who already trades perps. It opens with
the word "Perpetuals", its second sentence assumes the reader already scribbles
lines on screenshots before sizing a position, and it uses the word
"invalidation" twenty-three times. All of that is *correct*. None of it is for the
person we want.

The person we want has never placed a limit order. They have an opinion about
whether a number goes up, and they have a finger. The product's entire claim is
that those two things are now enough. The page has to be written like it
believes that.

**Audience:** someone who has used Robinhood or Cash App, or nothing at all.
Not someone who has used Hyperliquid.

**One-sentence positioning:** *You draw where you think the price is going, and
that drawing is the trade.*

**What we are not doing:** dumbing down the product, or hiding risk. We are
changing the vocabulary and the order of explanation. See §7.

---

## 2. What the references actually do

Pulled from the live pages, September 2026.

**fomo** (fomo.family) — the closest comparable; social-first consumer crypto
app that also offers perps. **Zero finance jargon on the entire page.** Not one
instance of leverage, liquidation, margin, slippage, funding rate, or
perpetuals. Their copy in full:

> **"where traders become legends."**
> "From memecoins to viral tokens, trade any crypto in seconds."
> "trade from anywhere. never lose a beat." / "Open a trade on your phone, close it on your desktop."
> "never miss out again" — "the only social-first trading app"
> Features: *become a legend, top the leaderboard* · *discover and follow top traders* · *real time notifications for what the best are buying* · *create an account in an instant* · *multichain & gasless* · *fund with apple pay*
> Close: **"a trading app for the rest of us"** — "join 2,500,000 traders making their name on fomo"

Note "ZERO COMPLEXITY" is used as a feature name. Note the social loop —
leaderboard, feed, alerts — is three of their six features.

**Robinhood** — "Start with as little as $1. Buy, sell, and transfer BTC, ETH,
SOL." Buy, sell, transfer. Never derivatives, never margin, on the front page.

**Polymarket** — never defines what a prediction market is. Shows live markets
with percentages and lets the interface teach.

### The lesson that matters

None of the three explain their mechanism in prose. That is not because they
have nothing to explain — Polymarket's product is genuinely strange — it is
because **they show the thing moving instead of describing it.**

So the takeaway is not "delete the explanation." It is: **make the hero canvas
interactive and the explanation problem mostly dissolves.** One drawable chart
does the work that three prose sections are currently doing badly. This is the
single highest-leverage change on the page and everything else in this spec
assumes it.

---

## 3. Rules of the page

1. **Show before tell.** No section explains a thing the reader could have just
   done. The canvas comes before the steps.
2. **One idea per section, one sentence per idea.** A section lead is *one*
   sentence, twelve words or fewer. If a section needs a paragraph to land, it
   is the wrong section.
   - The failure to watch for: **copy that narrates the demo sitting right
     under it.** The redraw section opened with sixty words explaining which
     values stay put, which follow the shape, and what happens if you drag past
     your entry — all of which the panel shows you the instant you touch it.
   - **But short is not the goal; short and still carrying the point is.** That
     redraw lead was first cut to "Drag the end of the line somewhere else.",
     which is an instruction with no reason to care attached. It now reads
     "Changed your mind? Drag the line somewhere else. It updates your trade,
     and costs nothing." — three facts a reader wants, still one line. Trim
     until the point is bare, then stop.
3. **Second person, present tense, plain verbs.** Draw, pick, watch, close.
4. **Every number is in dollars, at consumer scale.** Not percentages, not
   multiples, not R:R. "$40" not "1R". "Put in $100, trade like $500" not "5x".
   Every figure on the page is a $100 stake trading like $500, computed through
   `pnlAt` in `market-data.ts` — one place, so the sections cannot drift. The
   panels used to quote 2.5 BTC positions: +$8,050 beside a canvas quoting +$26
   made the page read as though written for two different people.
5. **No word a 15-year-old would have to look up.** See §4 for the list.
6. **Never hide the downside.** Simplifying vocabulary is not the same as
   softening risk. See §7.
7. **The page should be usable with the sound off and the copy skipped.** If
   someone only looks at the pictures, they should still learn that you draw a
   line and that becomes a trade.

---

## 4. Vocabulary

### Banned from the page

Occurrences across the section components (`src/components/site/*.tsx`),
including labels and prop values, not just prose:

| Word | Now | Why it goes |
|---|---:|---|
| invalidation | 23x | Means nothing outside trading. Worst offender by a distance. |
| margin / notional | 5x | Means nothing. |
| testnet | 7x | Reads as "not real money, so why am I here." |
| leverage / 5x | 4x | Vaguely ominous, precisely uninformative. |
| liquidation | 4x | See below. |
| perpetuals / perps | 2x | Sounds like a subscription. |
| non-custodial / wallet | 2x | Crypto-native only. |
| "block times came down" | 1x | Infrastructure trivia. |

Also banned: thesis, position, size (as a noun), fill, ticket, R:R, basis,
slippage, funding rate, order book, long/short (as nouns).

### Replacements

| Instead of | Say |
|---|---|
| Entry | where you start |
| Target | where you're aiming |
| Invalidation | where you're out — or "if you're wrong" |
| Liquidation price | **the most you can lose: $40** |
| Leverage 5x | put in $100, trade like $500 |
| Notional / margin | *(delete — never surfaced)* |
| Perpetuals | *(delete — or "bet on the price going up or down")* |
| Non-custodial | we never hold your money |
| Testnet | early access |
| "risk 1, reward 2.5" | risk $40 to make $100 |
| Redraw amends the position | change your mind? draw over it |

### On "liquidation" specifically

Liquidation means *the trade closed itself because the price moved too far
against you*. A normal user does not need the mechanism. They need one number:
**the most you can lose.** That framing is simpler *and* more honest than the
word it replaces — it tells them the consequence instead of naming the
machinery. It gets its own section (§5.5), it does not get deleted.

---

## 5. The page, section by section

Nine sections, down from the current eleven. Each one below gives its job, the
copy, and what it has to do visually.

### 5.0 Nav

Unchanged in structure. Two link items, log in, primary action.

- Links: **How it works** · **FAQ**
- Primary: **Start drawing** (currently "Start sketching" — "sketching" is a
  hobby, "drawing" is the verb we use everywhere else; pick one and never vary)
- "Soon" detail strings drop the word testnet: *"Opens with early access."*

### 5.1 Hero

**Job:** in four seconds, make someone understand the product well enough to
want to touch it.

Keep the headline — "Draw the chart. Trade the line." already passes every rule
in §3. Kill the kicker ("Perpetuals, drawn" makes the hardest word on the page
the first word on the page). Replace the sub, which currently only lands for
people who already trade.

> # Draw the line. That's the trade.
>
> Think it goes up? Draw it going up. That's the whole thing.
>
> `[ Try it — draw on the chart ]`  `[ How it works ]`

**Visual:** the canvas sits directly under the copy and is **live**. Empty
chart, a faint hand-drawn hint arc, a "drag across the chart" affordance that
dissolves on first touch. This is the change the whole spec hangs on — right
now `TradePanel` is a beautiful picture of the product, and a picture cannot
teach a gesture.

**Primary CTA scrolls to the canvas rather than opening a waitlist modal.** The
first thing we ask for is a finger, not an email.

> **Superseded (2026-09-29):** the app is live, so the primary CTA opens it
> (**Draw a trade**) and the landing no longer has a canvas of its own. See §9, item 2.

### 5.2 Try it

**Job:** the reader draws a line and sees what happens. This section replaces
`Thesis`, `WhatItSets`, and `BothEndings` entirely.

> ## Go on, draw something.
>
> Nothing's at stake. Drag across the chart and watch what it sets up.

**Data:** real BTC-USD hourly candles from Coinbase's public endpoint,
fetched on the server and cached for a minute, falling back to the old seeded
series if the call fails (`components/site/btc.ts`). Asking someone to have an
opinion about a random walk is asking them to have an opinion about nothing,
and the first thing anyone who knows the market does is check whether the
number is right.

**Interaction:** on release, the drawn line resolves into three labelled
points — *where you start*, *where you're aiming*, *where you're out* — and two
dollar figures appear beneath. A "draw again" reset. A "play it out" control
that animates the price either following the line or breaking it, so both
endings are something the reader *causes* rather than reads about.

This is where the current `BothEndings` content survives: as an outcome of
their own drawing, not as a worked example about 2.5 BTC at 5x.

### 5.3 How it works — three steps

**Job:** name the three things they do. Currently four steps; "Open" is not
something the user does, so it folds into step 3.

> ## Nothing to learn.
> Size, leverage, one line. That's it.
>
> **01 — Pick your size**
> How much you put in. Twenty dollars or two thousand.
>
> **02 — Set leverage**
> Put in $100, trade like $500. You choose how far it goes.
>
> **03 — Draw it**
> One line, roughly where you think it goes. No order types to learn.
>
> **04 — Watch it make money**
> The closer the chart follows your line, the better you do.

**Order is the product flow, not the best headline.** Drawing is the identity
of the product and it is still tempting to lead with it; it is third because
that is when you actually do it.

**"Leverage" is surfaced here**, against the §4 ban, on the owner's instruction —
the canvas header shows `5×` too, so hiding the word in one place while showing
the number in another was incoherent. The §4 replacement still governs the
body copy: the card says "trade like $500", never "5× leverage".

**Step 04 is scored on closeness, and that is the honest summary.** "The
closer the chart follows your line, the better you do" is not a new mechanic —
follow the line to your target and you take the most, diverge and you are out
at the price you drew underneath. It is the same rule the FAQ states, in the
form a person can feel. Its card shows the drawn line as a ghost with price
walking along it, so 03 and 04 read as one progression: you draw it, then the
chart either backs you up or it doesn't.

**Open — step 04's title.** "Watch it make money" reads as a profit guarantee
on a leveraged product, which is both false half the time and the kind of claim
regulators act on. It sits oddly beside a canvas built to show what you can
lose. Shipped as asked; flagged here because it is a one-line change and the
decision should be a deliberate one. The caption names both endings regardless.

Two traps this section already fell into:

- **A simplification that is a lie is not worth having.** The size card first
  read "it's the only number you type", false while leverage is also the user's
  to set. It is now two cards.
- **Never imply passive income.** Step 04 was first titled "Close the app" —
  walk away and watch it earn. Same objection now stands against its
  replacement; see above.

### 5.4 Both numbers

**Job:** the risk section. Where liquidation goes, translated.

> ## You know both numbers before you go in.
>
> **If it works** &nbsp; +$100
> **The most you can lose** &nbsp; $40
>
> That's the whole range. No surprise bill, no phone call at 3am.

**Visual:** one card, two figures, the loss figure given equal weight to the
gain — not smaller, not greyed out. Giving the downside equal typographic
weight is the honesty (§7) and it is also, per the references, the thing that
builds trust fastest with people who assume crypto is a scam.

### 5.5 Show your call

**Job:** the growth loop. **This is the section we are missing entirely today.**

fomo's real engine is not simplicity, it is the leaderboard and the feed —
three of their six features. We have something they do not: **a drawn line is
already an image.** It is the screenshot people send each other in group chats,
except ours is the actual order. That is a viral loop sitting unused.

> ## Show your call.
>
> Every skech is a picture. Post it before it plays out and let it settle in
> public.

**Visual:** a feed of real sketches — the drawn line, who drew it, and how it
ended. "Called it." / "Missed by $200." Leaderboard treatment is a natural
extension but is out of scope for v1 of the page.

### 5.6 Trust strip

**Job:** defuse "is this a scam." Four short lines, no section heading, small
type, one row.

> **We never hold your money** · **No account to approve** · **Start with $20** · **Nothing to install**

### 5.7 FAQ

Eight questions, rewritten against the thesis: **you only have to be right
about the direction.** The price range does not matter and was never the
claim — what a drawing says is "up from here, then down from there", and the
height of it is neither a target nor a band you have to land inside.

**Answers are short.** One to three plain sentences, under forty words, no
construction the reader has to unpick. An answer that reads as writing is an
answer that failed: someone is here because they do not know how this works,
and a paragraph with a rhetorical turn in it is a second thing to decode on
top of the first.

Two further rules. "Leverage" is **boost** on every consumer surface. And the
exits are **money you type, not levels you draw**: "put in $100, close it if I
lose $50, close it if I make $70".

> **What does my drawing actually do?**
> It says which way you think the price is going. Draw it going up and you win
> if it goes up. Draw it turning down and from that point you win if it falls.
> That is all it has to get right.
>
> **Do I have to guess the right price?**
> No. You are not picking a number or a range to land in. Draw up, and if it
> goes up you make money. The bigger the move, the more you make.
>
> **What if the price doesn't follow my line?**
> It won't, and that is fine. You get paid on which way the price actually
> went, not on how close it came to your line.
>
> **What closes a trade?**
> The clock, you, or a limit you set. A round lasts about a minute. You can
> close it early whenever you like. And if it goes far enough against you, it
> closes on its own.
>
> **Can I set a limit on what I lose?**
> Yes. You type the numbers: put in $100, close if I lose $50, close if I make
> $70. Both are optional, and you can never lose more than you put in.
>
> **What is the boost?**
> It makes your money work harder. At 50× your $100 moves like $5,000, so wins
> get bigger and so do losses. You still cannot lose more than you put in.
>
> **Do you hold my money?**
> No. Nothing to install, no account to approve, and we never hold your funds.
>
> **Why has nobody built this before?**
> Following a hand-drawn line means keeping up with the hand. Chains only got
> fast enough for that recently.

### 5.8 Close

Keep "Go draw something." — it is the best line on the current page.

> ## Go draw something.
>
> `[ Start drawing ]`  `[ How it works ]`
>
> You can lose what you put in. Never put in more than you'd be fine losing.

The disclaimer replaces "Perps can lose you everything you put up, and then
some. None of this is financial advice." — same warning, no vocabulary, and
"and then some" is a claim we should confirm is even true of our model before
it goes back on the page.

### 5.9 Footer

Drop "Perps" from the disclaimer line. Add a **For traders** link — see §6.

---

## 6. Cut list, and where it goes

Everything below is *correct* and traders will want it. It moves one click
deeper, it is not deleted.

| Cut | Why | Goes to |
|---|---|---|
| `Thesis` (holder vs. you) | Editorial argument. Consumer apps demo, they don't argue. | Nothing — it's a blog post |
| `WhatItSets` price ladder | The most technically impressive and most alienating thing on the page | `/for-traders` |
| `BothEndings` worked example | "2.5 BTC at 5x, in at 64,180" is a trade journal entry | Replaced by §5.2, detail to `/for-traders` |
| Hero kicker "Perpetuals, drawn" | First word is the hardest word | Gone |
| "Read the docs" in the close | Docs are not a consumer CTA | Footer |

**`/for-traders`** is a single page holding the full mechanism: the three price
levels by their real names, leverage, funding, how fills work against a drawn
path, the risk/reward maths. Linked from the footer and one line in the FAQ.
Nobody who needs it will fail to find it; nobody who doesn't will trip over it.

---

## 7. Risk and honesty

Simplifying vocabulary is not the same as softening risk, and we should be able
to defend every line here to a regulator.

- The maximum loss is stated as a **specific dollar figure**, given equal visual
  weight to the gain, in its own section (§5.4). The current page never states
  it in dollars at all.
- **A line that never dips risks the whole stake, and says so.** The level rule
  makes the lowest point you draw the place you get out, so a straight line up
  sets no floor — the first build quoted "—" there. That reads as *no downside*
  on the one panel whose job is the downside. It now reads "the most you can
  lose: $100", because with nothing to close you early the whole stake is on
  the table, which is both simpler and true. It is also what makes people draw
  a dip, which is the mechanic we most want understood.
- **Any shape the page draws for itself is a shape it is recommending.** The
  first pair of "not sure? try one" presets grazed the entry by half a percent
  and so advertised a ten-to-one trade. They now dip ~2.5% and resolve ~5%, a
  ratio a trader would not laugh at.
- No copy implies a drawn line is a prediction the market has agreed to. The
  FAQ says plainly that price almost never follows the line.
- The close carries a plain-language capital warning.
- We do not use the word "bet" in body copy, and we do not use gambling
  framing, despite it being the most natural consumer vocabulary here.
- **Answered: losses cannot exceed the deposit.** `settle` caps at minus the
  stake, which is what isolated margin does, and liquidation closes the position
  before it can go further. "And then some" was never true of our model; §5.4's
  "the most you can lose" framing is correct and the close's disclaimer stands
  as written.
- Zero terms from the §4 banned list appear in rendered copy. Greppable, so it
  can be a CI check.
- A reader who has never traded can say what the product does after four
  seconds on the hero.
- Time to first drawn line on the landing canvas is the primary funnel metric,
  ahead of signups.
- No sentence on the page runs past ~20 words, and no section lead past 12.
  Both are greppable.

---

## 9. Open decisions

1. **Can losses exceed the deposit?** Still the blocker, and now sharper: the
   canvas prints "the most you can lose: $100" as a hard cap. If losses can in
   fact exceed the deposit, that number is a lie and both it and the §5.8
   disclaimer have to change. Needs an answer before this page goes public.
2. ~~**"Start drawing" vs. "Start sketching"**~~ **Settled (2026-09-29):** the
   app is live, and every call to action is **Draw a trade**, one string
   everywhere (hero, close, and the sticky nav once the hero's is scrolled
   away), opening app.skech.trade. The nav leads with Talk to founders. The waitlist form,
   the video and the landing's practice chart are gone.
3. ~~**Is the landing canvas the real engine or a mock?**~~ **Settled:** the
   gesture, the level rule (shared with the FAQ via `levelsFor`) and the
   arithmetic are real, over real BTC candles. No wallet, no order. Still open
   underneath it: the chart does not yet poll, so the price is up to a minute
   stale, and the 5x multiple behind the dollar figures is hard-coded.
4. **Does §5.5 ship with real sketches or placeholders?** Placeholder social
   proof ages badly and we have no users yet. Option: ship §5.5 with our own
   sketches, labelled honestly, or hold the section until there is a feed.
5. **Do we keep the per-request pixel-font headline shuffle?** It is a lovely
   detail and it is the reason the page is `force-dynamic`. Unrelated to this
   rewrite, but worth a decision while we're in here.

---

## Appendix — what we're up against

| | Headline | Jargon on page |
|---|---|---|
| fomo | "where traders become legends." | none |
| Robinhood | "Start with as little as $1." | none on front page |
| Polymarket | *(no explanation at all)* | some — assumes betting literacy |
| **skech (now)** | "Draw the chart. Trade the line." | **8 distinct terms, 48 occurrences** |
| **skech (proposed)** | "Draw the line. That's the trade." | none |

Sources: fomo.family, robinhood.com, polymarket.com — read September 2026.
