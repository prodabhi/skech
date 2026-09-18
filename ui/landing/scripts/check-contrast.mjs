/**
 * Contrast check for text that sits over artwork.
 *
 * axe reports colour-contrast as "incomplete" wherever text overlaps an image,
 * which on this page is most of the hero. This resolves it properly: it reads
 * each text node's computed colour and its real on-screen box, then samples the
 * darkest pixels inside that box from a screenshot, those are the background
 * showing between the glyphs, and reports the true ratio.
 *
 *   bun scripts/check-contrast.mjs <url> <width>
 */
import sharp from "sharp";

const url = process.argv[2] ?? "http://localhost:3000/";
const W = Number(process.argv[3] ?? 1440);
const DSF = 2;

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9300 + Math.floor(Math.random() * 150);
const proc = Bun.spawn(
  [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
   `--remote-debugging-port=${PORT}`, `--window-size=${W},900`,
   "--user-data-dir=/tmp/skech-contrast", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);
async function endpoint() {
  for (let i = 0; i < 120; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = tabs.find((t) => t.type === "page");
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("no devtools endpoint");
}
const ws = new WebSocket(await endpoint());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pend = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { id++; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: DSF, mobile: W < 768 });
await send("Page.navigate", { url });
await Bun.sleep(2600);

// Resize to the full document height so every text node is "in viewport".
// Checking only the first 900px silently skipped most of the page, which is
// exactly where a new background pattern would go unnoticed.
const metrics = (await send("Page.getLayoutMetrics")).result;
const fullHeight = Math.ceil(
  (metrics.cssContentSize ?? metrics.contentSize).height,
);
await send("Emulation.setDeviceMetricsOverride", {
  width: W,
  height: fullHeight,
  deviceScaleFactor: DSF,
  mobile: W < 768,
});
await Bun.sleep(2200);

const nodes = (await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
  const out = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.textContent.trim();
    if (t.length < 2) continue;
    const el = n.parentElement;
    if (!el || el.closest("[hidden],.sr-only")) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    const b = r.getBoundingClientRect();
    if (b.width < 4 || b.height < 4) continue;
    out.push({
      text: t.slice(0, 30), color: cs.color,
      size: parseFloat(cs.fontSize), weight: cs.fontWeight,
      box: [b.left, b.top, b.right, b.bottom].map(Math.round),
    });
  }
  return out;
})()` })).result?.result?.value ?? [];

const shot = (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })).result.data;
const png = Buffer.from(shot, "base64");
const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
const { width: PW, channels: CH } = info;

const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const x = L(a), y = L(b); const hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
const parseColor = (c) => c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

let worstRatio = 99;
let worstLine = "";
let fails = 0;

for (const n of nodes) {
  const fg = parseColor(n.color);
  const [x0, y0, x1, y1] = n.box.map((v) => v * DSF);
  // The background is whatever shows between the glyphs. Which extreme that
  // is depends on the polarity: light text on dark means the background is the
  // darkest pixel in the box, dark text on a light pill means it is the
  // brightest. Sample both and pick the one on the far side of the text.
  let darkest = null, darkestL = 1e9, brightest = null, brightestL = -1;
  const lums = [];
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < Math.min(x1, PW); x++) {
      const i = (y * PW + x) * CH;
      const p = [data[i], data[i + 1], data[i + 2]];
      const l = L(p);
      lums.push(l);
      if (l < darkestL) { darkestL = l; darkest = p; }
      if (l > brightestL) { brightestL = l; brightest = p; }
    }
  }
  // Compare against the box median, not the midpoint of the extremes: display
  // lines overlap at leading 0.95, so a neighbouring glyph can be the brightest
  // pixel in the box and would flip the polarity the wrong way.
  lums.sort((a, b) => a - b);
  const median = lums[Math.floor(lums.length / 2)];
  const fgL = L(fg);
  const bg = fgL >= median ? darkest : brightest;
  if (!bg) continue;
  const r = ratio(fg, bg);
  // WCAG large text: >=24px, or >=18.66px bold.
  const large = n.size >= 24 || (n.size >= 18.66 && Number(n.weight) >= 700);
  const need = large ? 3 : 4.5;
  const ok = r >= need;
  if (!ok) {
    fails++;
    console.log(`FAIL ${r.toFixed(2)}:1 (needs ${need})  "${n.text}"  ${n.size}px  fg ${n.color} on rgb(${bg.join(",")})`);
  }
  if (r - need < worstRatio - (large ? 3 : 4.5) || worstLine === "") {
    if (r < worstRatio) { worstRatio = r; worstLine = `"${n.text}" ${r.toFixed(2)}:1 (${large ? "large" : "normal"})`; }
  }
}

console.log(`\n${W}px, ${nodes.length} text nodes checked, ${fails} failing`);
console.log(`lowest ratio: ${worstLine}`);

ws.close();
proc.kill();
