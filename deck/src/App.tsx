import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Deck from './deck/Deck';
import Slide from './deck/Slide';
import Build from './deck/Build';
import Reveal from './deck/Reveal';
import { useDeck } from './deck/DeckContext';
import CountUp from './components/CountUp';
import Team from './components/Team';

/* The mark is one flat shape, so it is a mask filled with the text colour, as on the site. */
function Mark({ size }: { size: string }) {
  return <span className="sk-mark" aria-hidden="true" style={{ width: size }} />;
}

/* One line of ink with the dot at its end: the brand's whole idea, drawn once under the name. */
function InkLine() {
  return (
    <svg className="sk-inkline" viewBox="0 0 520 40" aria-hidden="true">
      <path d="M6 28 C 90 36, 150 8, 250 18 S 420 32, 506 10" pathLength={1} />
      <circle cx="506" cy="10" r="6" />
    </svg>
  );
}

/* An ordinary order ticket. Its values are examples of what such a form asks for, not skech's. */
const TICKET = [
  ['Order type', 'Limit'],
  ['Size', '0.01 BTC'],
  ['Leverage', '5×'],
  ['Limit price', '82,950.00'],
  ['Stop', '82,400.00'],
  ['Take profit', '84,200.00'],
];

function OrderTicket() {
  return (
    <div className="sk-ticket">
      <div className="sk-card-head">New order</div>
      {TICKET.map(([label, value]) => (
        <div className="sk-ticket-row" key={label}>
          <span>{label}</span>
          <span>{value}</span>
        </div>
      ))}
      <div className="sk-ticket-btn">Confirm</div>
    </div>
  );
}

function OneLine() {
  return (
    <div className="sk-oneline">
      <div className="sk-card-head">
        <Mark size="18px" />
        skech
      </div>
      <svg viewBox="0 0 300 220" aria-hidden="true">
        <polyline className="sk-price" points="0,150 26,144 48,152 74,136 98,140 122,126 140,130" />
        <circle className="sk-price-dot" cx="140" cy="130" r="4.5" />
        <path className="sk-ink" d="M160 122 C 196 112, 214 78, 286 46" />
      </svg>
      <div className="sk-oneline-foot">One line</div>
    </div>
  );
}

/* The launch film, picture only. Thumbnails show its poster so the rail never plays video. */
function Film() {
  const { isStatic } = useDeck();
  if (isStatic) return <img className="sk-film" src="/film/poster.png" alt="" />;
  return (
    <video
      className="sk-film"
      autoPlay
      muted
      loop
      playsInline
      poster="/film/poster.png"
      aria-label="skech launch film: One line"
    >
      <source src="/film/skech-one-line.mp4" type="video/mp4" />
    </video>
  );
}

/* Which of the eight seconds the price runs through, here and in the chart below. */
const HITS = [true, true, false, false, true, true, true, false];

function StepAmount() {
  return (
    <div className="sk-amounts" aria-hidden="true">
      <span>10¢</span>
      <span className="on">50¢</span>
      <span>$1</span>
    </div>
  );
}

function StepLine() {
  return (
    <svg viewBox="0 0 220 96" aria-hidden="true">
      <line className="sk-dash" x1="6" y1="62" x2="214" y2="62" />
      <path className="sk-ink thin" d="M6 62 C 22 54, 34 50, 48 56 S 76 78, 92 78 S 132 50, 152 40 S 190 40, 214 18" />
      <circle className="sk-ink-dot" cx="214" cy="18" r="4.5" />
    </svg>
  );
}

function StepPaid() {
  return (
    <svg viewBox="0 0 220 96" aria-hidden="true">
      {HITS.map((hit, i) => (
        <rect
          key={i}
          className={hit ? 'sk-hit' : 'sk-miss'}
          x={8 + i * 26}
          y={62 - i * 5}
          width="20"
          height="20"
          rx="6"
        />
      ))}
    </svg>
  );
}

const STEPS: { no: string; title: string; body: string; art: ReactNode }[] = [
  {
    no: '01',
    title: 'Pick what a dot costs',
    body: 'A few cents or a few dollars, the same for every dot.',
    art: <StepAmount />,
  },
  {
    no: '02',
    title: 'Draw where it goes',
    body: 'Ahead of the price, up to 30 seconds out.',
    art: <StepLine />,
  },
  {
    no: '03',
    title: 'The ink it runs through pays',
    body: 'Each second the price spends inside your line pays.',
    art: <StepPaid />,
  },
];

/* A line of ink, cut into eight one-second pieces, and the price taking its own path through it.
   Geometry in SVG units: the ink's height at each second's edge, the price four times a second. */
const X0 = 240;
const SEC = 84;
const N = 8;
const INK = [200, 186, 168, 152, 140, 122, 108, 98, 78];
const PAST = '0,236 30,230 58,238 86,224 112,228 140,214 168,220 196,208 218,212 240,204';
const PRICE = [
  204, 199, 196, 192, 188, 183, 178, 176, 171, 180, 192, 204, 214, 218, 212, 206, 196, 176, 150,
  128, 120, 117, 114, 112, 108, 106, 103, 101, 110, 122, 134, 150, 162,
];

/* Seconds elapsed, 0 to 8, looping. Thumbnails and reduced motion show the settled chart. */
function useSeconds() {
  const { isStatic } = useDeck();
  const [t, setT] = useState(isStatic ? N : 0);
  useEffect(() => {
    if (isStatic || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setT(N);
      return;
    }
    const per = 750;
    const lead = 700;
    const total = lead + N * per + 2600;
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const e = (now - t0) % total;
      setT(Math.max(0, Math.min(N, (e - lead) / per)));
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [isStatic]);
  return t;
}

function InkChart() {
  const t = useSeconds();
  const p = t * 4;
  const whole = Math.floor(p);
  const pts = PRICE.slice(0, whole + 1).map((y, j) => [X0 + (j * SEC) / 4, y]);
  if (whole < PRICE.length - 1) {
    const f = p - whole;
    pts.push([X0 + (p * SEC) / 4, PRICE[whole] + (PRICE[whole + 1] - PRICE[whole]) * f]);
  }
  const head = pts[pts.length - 1];
  /* A hit pays the moment the price reaches it; a miss settles once its second closes. */
  const state = (i: number) => (HITS[i] ? (t >= i + 0.6 ? 'hit' : 'open') : t >= i + 1 ? 'miss' : 'open');
  const paid = HITS.filter((_, i) => state(i) === 'hit').length;
  const missed = HITS.filter((_, i) => state(i) === 'miss').length;
  return (
    <div className="sk-chart">
      <svg viewBox="0 0 960 330" aria-hidden="true">
        {INK.map((_, i) => (
          <line key={i} className="sk-chart-sec" x1={X0 + i * SEC} y1="30" x2={X0 + i * SEC} y2="292" />
        ))}
        {HITS.map((_, i) => (
          <text key={i} className="sk-chart-tick" x={X0 + (i + 0.5) * SEC} y="314">
            +{i + 1}s
          </text>
        ))}
        {HITS.map((_, i) => (
          <line
            key={i}
            className={'sk-chart-ink ' + state(i)}
            x1={X0 + i * SEC}
            y1={INK[i]}
            x2={X0 + (i + 1) * SEC}
            y2={INK[i + 1]}
          />
        ))}
        <polyline className="sk-price" points={PAST} />
        <polyline className="sk-price" points={pts.map((q) => q.join(',')).join(' ')} />
        <circle className="sk-price-dot" cx={head[0]} cy={head[1]} r="6" />
      </svg>
      <div className="sk-chart-key">
        <span>
          <i className="hit" />
          Paid {paid}
        </span>
        <span>
          <i className="miss" />
          Missed {missed}
        </span>
        <span>
          <i className="open" />
          Still ahead {N - paid - missed}
        </span>
      </div>
    </div>
  );
}

/* The ladder every piece of ink pays on, and how often each rung was hit in the replay. */
const LADDER: [number, string][] = [
  [1.1, '68%'],
  [1.5, '49%'],
  [2, '34%'],
  [3, '24%'],
  [4, '17%'],
  [6, '12%'],
  [8, '9%'],
  [12, '6.6%'],
  [16, '4.8%'],
  [24, '3.1%'],
  [32, '2.4%'],
  [48, '1.7%'],
  [64, '1.1%'],
  [96, '0.8%'],
  [128, '0.4%'],
];

function Ladder() {
  return (
    <div className="sk-ladder">
      {LADDER.map(([x, hit], i) => (
        <div className="sk-rung" key={x}>
          <div className="sk-rung-x">{x}×</div>
          <div className="sk-rung-bar">
            <span
              style={{
                height: `${8 + (92 * Math.log2(x)) / 7}%`,
                animationDelay: `${0.25 + i * 0.04}s`,
                background: `color-mix(in srgb, var(--primary) ${30 + i * 5}%, var(--surface))`,
              }}
            />
          </div>
          <div className="sk-rung-hit">{hit}</div>
        </div>
      ))}
    </div>
  );
}

/* Four people's lines on one chart. Colours only: no names, no faces, nobody real. */
const CROWD = [
  'M6 66 C 30 60, 50 46, 74 48 S 112 30, 132 20',
  'M6 78 C 28 76, 52 68, 72 70 S 110 58, 128 50',
  'M6 52 C 26 44, 48 50, 70 38 S 108 40, 126 34',
  'M6 88 C 30 86, 54 84, 76 80 S 114 74, 130 70',
];
const CROWD_END = [
  [132, 20],
  [128, 50],
  [126, 34],
  [130, 70],
];

function Crowd() {
  return (
    <svg className="sk-crowd" viewBox="-6 4 150 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {CROWD.map((d, i) => (
        <g key={i} className={'c' + (i + 1)}>
          <path d={d} pathLength={1} style={{ animationDelay: `${0.3 + i * 0.25}s` }} />
          <circle cx={CROWD_END[i][0]} cy={CROWD_END[i][1]} r="4" />
        </g>
      ))}
    </svg>
  );
}

const FEES = [
  { label: 'What you put in', fee: '4%', holders: '3%', skech: '1%' },
  { label: 'Profit when you are paid', fee: '10%', holders: '8%', skech: '2%' },
  { label: 'Pool surplus above its reserve', fee: '', holders: '75%', skech: '25%' },
];

const SKT = [
  { fig: '100 SKT', body: 'per dollar at the start, less as the game grows.' },
  { fig: '26 weeks', body: 'and SKT halves. Keep playing to keep your share.' },
  { fig: '10%', body: 'of all SKT is the most one wallet can hold.' },
  { fig: 'Always staked', body: 'SKT can’t be sold or sent.' },
];

const NEXT = [
  {
    time: 'Now',
    title: 'Live on devnet',
    body: 'The game on the web and in a phone app, played for test USDC on Solana devnet.',
  },
  {
    time: 'Next',
    title: 'Before mainnet',
    body: 'Odds retrained on recent days. Admin and upgrade keys to a multisig. Legal advice.',
  },
  {
    time: 'Later',
    title: 'Mainnet',
    body: 'The same drawing, for real USDC.',
  },
];

export default function App() {
  return (
    <Deck>
      {/* 1. Cover */}
      <Slide center nav="Cover" notes="Say the name, sketch, then the line: draw the chart, trade the line. Hold.">
        <Reveal>
          <div className="sk-lockup">
            <Mark size="0.95em" />
            <span>skech</span>
          </div>
        </Reveal>
        <InkLine />
        <Reveal delay={0.3}>
          <div className="sk-tag">Draw the chart. Trade the line.</div>
        </Reveal>
      </Slide>

      {/* 2. Problem */}
      <Slide
        center
        nav="Problem"
        className="sk-problem"
        notes="Everyone has a view. The order form is the obstacle. One line replaces it."
      >
        <Reveal>
          <h2 className="headline sk-wide">You have a view on Bitcoin’s next move.</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">Most of the time you never trade it. Placing a trade takes too many steps.</p>
        </Reveal>
        <div className="sk-versus">
          <Reveal delay={0.1}>
            <OrderTicket />
          </Reveal>
          <Reveal delay={0.16} className="sk-versus-next">
            <span className="sk-arrow" aria-hidden="true">
              →
            </span>
            <OneLine />
          </Reveal>
        </div>
        <Reveal delay={0.22}>
          <p className="sk-caption">What once took an order form now takes one line.</p>
        </Reveal>
      </Slide>

      {/* 3. What it is: the launch film */}
      <Slide center nav="skech?" notes="Let the film run once. It is silent here; talk over it or let it play.">
        <Reveal>
          <h2 className="headline sk-wide">
            skech<span className="sk-q">?</span>
          </h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">
            Draw where you think Bitcoin goes. That drawing is the trade.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <Film />
        </Reveal>
      </Slide>

      {/* 4. How it works */}
      <Slide center nav="How it works" notes="Three decisions, in the order you make them. No order types.">
        <Reveal>
          <h2 className="headline sk-wide">Nothing to learn.</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">An amount, a line, and whatever the price does to it.</p>
        </Reveal>
        <div className="sk-panels" style={{ ['--n' as string]: 3 }}>
          {STEPS.map((s, i) => (
            <Reveal key={s.no} delay={0.1 + i * 0.08} className="sk-panel">
              <div className="sk-panel-art">{s.art}</div>
              <div className="sk-no">{s.no}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </Slide>

      {/* 5. What pays: the line, a second at a time */}
      <Slide
        center
        nav="What pays"
        notes="Watch one line settle. Five of its eight seconds are crossed and pay; three are missed and are gone."
      >
        <Reveal>
          <h2 className="headline sk-wide">Only the ink it runs through pays.</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">
            Your line is cut into one-second pieces. Each pays if the price comes through it that second.
          </p>
        </Reveal>
        <Reveal delay={0.1}>
          <InkChart />
        </Reveal>
      </Slide>

      {/* 6. The ladder */}
      <Slide
        center
        nav="The ladder"
        notes="One ladder for every piece of ink. Likely ink pays little, long shots pay up to 128 times."
      >
        <Reveal>
          <h2 className="headline sk-wide">1× to 128× what it cost.</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">The less likely the ink, the more it pays.</p>
        </Reveal>
        <Reveal delay={0.1}>
          <Ladder />
          <p className="sk-source">
            Above each bar, what a hit pays. Below it, how often that rung was hit in the replay: single taps spread
            over a laptop-sized map.
          </p>
        </Reveal>
      </Slide>

      {/* 7. Price history and verifiable payouts */}
      <Slide
        center
        nav="Measured"
        notes="Chances come from real Bitcoin price history. A local model calibrated price difficulty to 50/50; the payout equation runs onchain and is verifiable."
      >
        <Reveal>
          <h2 className="headline sk-wide">Chances come from real Bitcoin price history</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">
            We ran a local model to calibrate the price difficulty to 50/50. The payout equation is entirely
            onchain and verifiable.
          </p>
        </Reveal>
        <div className="sk-panels" style={{ ['--n' as string]: 3 }}>
          <Reveal delay={0.1} className="sk-panel sk-stat">
            <div className="sk-fig">
              <CountUp to={16000} />
            </div>
            <p>real 30-second stretches of Coinbase BTC-USD in the library</p>
          </Reveal>
          <Reveal delay={0.18} className="sk-panel sk-stat">
            <div className="sk-fig">
              <CountUp to={172777} />
            </div>
            <p>drawings opened in one replay, across ten screen sizes and three pens</p>
          </Reveal>
          <Reveal delay={0.26} className="sk-panel sk-stat">
            <div className="sk-fig">
              <CountUp to={8047900} />
            </div>
            <p>invariant checks passed in that replay</p>
          </Reveal>
        </div>
      </Slide>

      {/* 8. What skech enables */}
      <Slide center nav="Features" notes="From the first free run to playing with everyone else's ink on your chart.">
        <Reveal>
          <h2 className="headline sk-wide">What skech enables.</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">From your first free run to the ink that pays.</p>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="sk-bento">
            <div className="sk-tile">
              <div>
                <h3>Social trading</h3>
                <p>Other players’ lines appear on your chart as they draw them.</p>
              </div>
              <Crowd />
            </div>
            <div className="sk-tile">
              <div>
                <h3>Try it free</h3>
                <p>A full run on the real odds. No wallet, no sign-in.</p>
              </div>
              <img src="/illo/practice.png" alt="" />
            </div>
            <div className="sk-tile">
              <div>
                <h3>Bitcoin, second by second</h3>
                <p>One market, judged a second at a time.</p>
              </div>
              <img src="/illo/bitcoin.png" alt="" />
            </div>
            <div className="sk-tile">
              <div>
                <h3>Funds in. Funds out.</h3>
                <p>Easy deposits and withdrawals, all in one place.</p>
              </div>
              <img src="/illo/funding-v4.png" alt="" />
            </div>
          </div>
        </Reveal>
      </Slide>

      {/* 9. Revenue */}
      <Slide center nav="Revenue" notes="Two fees. Most of each goes back to the players who hold SKT; skech keeps the rest.">
        <Reveal>
          <h2 className="headline sk-wide">Revenue</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">Two fees, the same whatever you draw.</p>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="sk-table">
            <div className="sk-tr head">
              <span />
              <span>Fee</span>
              <span>To SKT holders</span>
              <span className="hl">To skech</span>
            </div>
            {FEES.map((f) => (
              <div className="sk-tr" key={f.label}>
                <span>{f.label}</span>
                <span>{f.fee}</span>
                <span>{f.holders}</span>
                <span className="hl">{f.skech}</span>
              </div>
            ))}
          </div>
        </Reveal>
        <Build at={1}>
          <p className="sk-caption">Most of every fee goes back to the players who hold SKT.</p>
        </Build>
      </Slide>

      {/* 10. SKT */}
      <Slide center nav="SKT" notes="Players whose predictions miss earn skech tokens (SKT). Token holders share in the game's revenue, claimed in USDC.">
        <Reveal>
          <h2 className="headline sk-wide">Missed Bitcoin predictions earn skech tokens.</h2>
        </Reveal>
        <Reveal delay={0.06}>
          <p className="lead sk-lead">
            Players whose predictions miss earn skech tokens (SKT). Token holders share in the game’s revenue,
            claimed in USDC.
          </p>
        </Reveal>
        <div className="sk-panels" style={{ ['--n' as string]: 4 }}>
          {SKT.map((s, i) => (
            <Reveal key={s.fig} delay={0.1 + i * 0.08} className="sk-panel sk-stat">
              <div className="sk-fig sm">{s.fig}</div>
              <p>{s.body}</p>
            </Reveal>
          ))}
        </div>
      </Slide>

      {/* 11. What's next */}
      <Slide center nav="Roadmap" notes="Live on devnet now. The list before mainnet is short and specific.">
        <Reveal>
          <h2 className="headline sk-wide">What’s next.</h2>
        </Reveal>
        <div className="sk-panels sk-next" style={{ ['--n' as string]: 3 }}>
          {NEXT.map((n, i) => (
            <Reveal key={n.time} delay={0.1 + i * 0.08} className="sk-panel">
              <div className="sk-time">{n.time}</div>
              <h3>{n.title}</h3>
              <p>{n.body}</p>
            </Reveal>
          ))}
        </div>
      </Slide>

      {/* 12. Team */}
      <Slide center nav="Team" notes="Who builds it.">
        <Reveal>
          <h2 className="headline sk-wide" style={{ marginBottom: 'clamp(20px, 3.4vh, 36px)' }}>
            Team
          </h2>
        </Reveal>
        <Team
          people={[
            { name: 'Abhi', role: 'Founder', img: '/team/abhi.jpg', href: 'https://t.me/Oxabhii' },
            { name: 'Swayam', role: 'Engineering', img: '/team/swayam.jpg', href: 'https://x.com/devswayam' },
            { name: 'Vivek Sahu', role: 'Engineering', img: '/team/vivek.png' },
          ]}
        />
      </Slide>

      {/* 13. Early traction */}
      <Slide center nav="Traction" notes="We acquired our first 10 users from X.">
        <Reveal>
          <h2 className="headline sk-wide">Our first users came from X.</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="sk-traction-number">10</div>
          <p className="sk-caption">We acquired our first 10 users from X.</p>
        </Reveal>
      </Slide>

      {/* 14. Close */}
      <Slide center nav="Close" notes="Ask them to draw one line. Leave the address on screen.">
        <Reveal>
          <img className="sk-scene" src="/illo/cta-scene.png" alt="" />
        </Reveal>
        <Reveal delay={0.08}>
          <h2 className="display sk-close">Go draw something.</h2>
        </Reveal>
        <Build at={1}>
          <p className="sk-url"><a href="https://app.skech.trade" target="_blank" rel="noopener noreferrer">app.skech.trade</a></p>
        </Build>
        <Reveal delay={0.3}>
          <p className="sk-source">You can lose what you put in. Never put in more than you’d be fine losing.</p>
        </Reveal>
      </Slide>
    </Deck>
  );
}
