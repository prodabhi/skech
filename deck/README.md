# skech — the deck

Skech's pitch deck, built as a web app: 14 slides, each one a responsive page you can present from a browser.

[skech.trade](https://skech.trade) · Draw the chart. Trade the line.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

The deck is its own npm project, outside the repo's Bun workspaces, so it installs and runs by itself:

```bash
cd deck
npm install
npm run dev
```

Open the address it prints (usually http://localhost:5173).

`npm run build` writes a static site to `dist/`, which any static host can serve. `npm run preview` serves that build locally.

## Present it

| Key | Action |
| --- | --- |
| `→` `↓` `Space` | Next (reveals builds first) |
| `←` `↑` | Previous (rewinds builds) |
| `Home` / `End` | First / last slide |
| `S` | Sidebar: thumbnail rail |
| `G` | Grid view: every slide at once |
| `A` | Annotate: pen, highlighter, shapes, eraser |
| `F` | Fullscreen |
| `P` | Presenter mode: a synced second tab with notes and a timer |
| `H` | Hide the UI |
| `Esc` | Close overlays |

The URL hash tracks the slide (`/#7`), so a link can open on any slide. Slides 9 and 14 have one click-build each. Slide 2 shows the full comparison immediately.

## Where things are

```
src/App.tsx              the 14 slides and their small components (order ticket, ink chart, ladder)
src/styles/tokens.css    the theme: paper, ink, ballpoint blue, Inter
src/styles/base.css      system styles; the block at the end, "SKECH", is this deck's own
src/components/          the slide component library (the deck uses Team and CountUp)
src/deck/                the deck engine and its chrome: leave as is
public/                  the mark, illustrations, team photos and the launch film (picture only)
```

To change a slide, edit `src/App.tsx`; each top-level child of `<Deck>` is one slide. To re-theme, edit the `:root` block of `src/styles/tokens.css`.

## What is on the slides

- Product facts, figures, copy and brand come from this repo: [`docs/HOW-IT-WORKS.md`](../docs/HOW-IT-WORKS.md), the landing site ([`ui/landing`](../ui/landing)) and the app's own explanations ([`packages/core/src/explain.ts`](../packages/core/src/explain.ts)). When those change, the slides need the same change by hand.
- The chart on slide 5 and the four lines under "Everyone's ink, live" are drawn for the deck. They are not recordings of real play.
- The order ticket on slide 2 is an ordinary one; its values are made-up examples, not skech's.
- The launch film on slide 3 plays without sound.
- The game is on Solana devnet today, where the USDC is test money.

You can lose what you put in. Never put in more than you'd be fine losing.

## Credit and licence

The deck engine (`src/deck`, `src/components`, most of `src/styles/base.css`) is [Bolt Slides](https://github.com/stackblitz/bolt-slides) by StackBlitz, [MIT](./LICENSE) licensed; that licence file covers the engine. Its repo has the guide to authoring slides.

Skech's name, mark, illustrations and film belong to Skech.
