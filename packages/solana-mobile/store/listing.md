# Google Play listing

Everything Play Console asks for, ready to paste. Placeholders in `[brackets]` are the owner's to fill.
The form answers below describe what the app does; they have to stay true to it, whatever the listing says.

## Main store listing

**App name** (30 max): `skech`

**Short description** (80 max):

```
Predict where Bitcoin goes next. Draw it on the chart.
```

**Full description** (4000 max):

```
Predict where Bitcoin goes next. Draw it.

Bitcoin's live price runs across the screen, second by second.
Draw a line ahead of it: where you think the price goes.
Every part of your line the price runs through pays a set multiple.
Further from the price pays more. Closer pays less.
The parts it misses, you lose what you put on them.

See what a line can earn before you lift your finger.
Pick how much each dot of ink is worth, from 10 cents.
Results land within seconds, not days.

Your balance sits in the game's program on the Solana blockchain.
Sign in with email or SMS, or with your own Solana wallet.
Deposit and withdraw USDC at any time.

Fees: 4% of what you put in, and 10% of profit.
Prices come from Coinbase, checked against Binance and Kraken.

You can lose what you put in. Only use money you can afford to lose.
18+ only. Not available where prohibited by law. Not investment advice.
```

**App icon:** `icon-512.png` (512×512)
**Feature graphic:** `feature-graphic.png` (1024×500)
**Phone screenshots** (2–8, 1080×1920 or similar): taken from a phone, see the end of this file.

**Category:** Finance. **Tags:** cryptocurrency, Bitcoin, price prediction.
**Contact email:** `team@skech.trade`. **Website:** `https://www.skech.trade`.
**Privacy policy:** `https://www.skech.trade/privacy`.

## App content (Policy → App content)

**Privacy policy:** `https://www.skech.trade/privacy`

**App access:** "All or some functionality is restricted." Give reviewers a way in:
- Test account: an email address set up in Privy (dashboard → Users → test accounts) with a fixed login code.
- Instructions: "Sign in with the email and code below. The account holds test USDC on Solana devnet. Draw a line to the
  right of the price to make a prediction."

**Ads:** No, the app contains no ads.

**Content rating (IARC questionnaire):** answer each question for what the app does. The facts the questionnaire
asks about:
- Users put money (USDC) on where the price goes and are paid or lose it based on the outcome, within seconds.
- No violence, sexual content, profanity, drugs, or user-to-user chat. No location sharing. Users don't interact
  with each other.
- The app has purchases of value in the sense that users deposit and withdraw real money (USDC).

**Target audience:** 18 and over only. Not designed for children. Not in the "Designed for Families" programme.

**News app:** No. **COVID-19 app:** No. **Government app:** No.

**Financial features:** declare what applies:
- Cryptocurrency wallet: yes (an embedded non-custodial wallet via Privy, or the user's own wallet).
- Anything about binary options, trading, or gambling in this declaration: answer as the product works (see the
  description above), on a lawyer's advice. Play's Financial Services policy prohibits binary options apps, and
  real-money games of chance need Play's gambling approval.

**Data safety:**

| Data type | Collected | Shared | Optional | Purpose |
|---|---|---|---|---|
| Personal info → Email address | Yes | No (Privy is a service provider) | Yes (one of email, phone or a wallet) | Account management |
| Personal info → Phone number | Yes | No | Yes | Account management |
| Financial info → Other financial info (wallet address, balances, predictions, deposits, withdrawals) | Yes | No | No | App functionality |
| App activity → Other user-generated content (the lines drawn) | Yes | No | No | App functionality |

- Not collected by the Android app: location, contacts, photos/videos, audio, files, calendar, health, messages,
  web history, device or other IDs, crash logs, diagnostics, analytics. The app has no analytics or crash SDK.
- IP address is used only for rate limiting and not stored, so it is not declared as collected.
- Data is encrypted in transit: Yes (https and wss).
- Users can request that data be deleted: Yes. Account deletion URL: `https://www.skech.trade/delete-account`.
  Predictions, deposits and withdrawals on the public blockchain cannot be deleted; the privacy policy says so.
- Independent security review: No.

**Account deletion:** in the app, Settings → Delete account; on the web, `https://www.skech.trade/delete-account`.

## Screenshots to take

On a phone, signed in, in light mode, with a balance:
1. The game, a fresh line drawn ahead of the price, the "In play / Could earn" pill showing.
2. The price running through a line, green amounts floating.
3. A round's result, "Profit +$…".
4. Deposit sheet with the wallet address and QR code.
5. Sign-in sheet.
6. How it works.

`adb exec-out screencap -p > shot.png` with the phone plugged in.
