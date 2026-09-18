/**
 * Headless layout probe + screenshot over the Chrome DevTools Protocol.
 * No extra dependencies, it drives the installed Chrome directly.
 *
 *   bun scripts/inspect.mjs <url> <width> <height> [out.png] [--full]
 *
 * Reports document overflow and names any element sticking out past the
 * viewport, which is the usual cause of a page that scrolls sideways on mobile.
 *
 * Note: Chrome's plain `--screenshot --window-size` flag does NOT set the
 * layout viewport, so it silently renders mobile widths at a desktop layout.
 * Emulation.setDeviceMetricsOverride is the only reliable way to do this.
 */
const args = process.argv.slice(2);
const FULL = args.includes("--full");
const REDUCED = args.includes("--reduced-motion");
const [url = "http://localhost:3000/", w = "375", h = "800", out] = args.filter(
  (a) => !a.startsWith("--"),
);
const WIDTH = Number(w);
const HEIGHT = Number(h);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9222 + Math.floor(Math.random() * 200);

const proc = Bun.spawn(
  [
    CHROME,
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    "--user-data-dir=/tmp/skech-cdp-profile",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

async function endpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await r.json();
      const page = tabs.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("chrome devtools endpoint never came up");
}

const ws = new WebSocket(await endpoint());
await new Promise((res) => ws.addEventListener("open", res, { once: true }));

let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    id++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails));
  }
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: WIDTH < 768,
});
if (REDUCED) {
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
}
await send("Page.navigate", { url });
await Bun.sleep(2500);

const report = await evaluate(`(() => {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") || "").slice(0, 90),
        left: Math.round(r.left),
        right: Math.round(r.right),
      });
    }
  }
  return {
    innerWidth: window.innerWidth,
    clientWidth: vw,
    scrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflowBy: de.scrollWidth - vw,
    offenders: offenders.slice(0, 14),
    motion: (() => {
      const g = document.querySelector(".grid-drift");
      const gs = g ? getComputedStyle(g) : null;
      return {
        gridSurfaces: document.querySelectorAll(".grid-drift").length,
        gridAnimation: gs ? gs.animationName + ' / ' + gs.animationDuration : null,
        dividers: document.querySelectorAll(".stroke-draw").length,
        dividersDrawn: document.querySelectorAll("[data-drawn] .stroke-draw").length,
      };
    })(),
    heroStroke: (() => {
      const el = document.querySelector(".hero-stroke");
      const head = document.querySelector(".hero-stroke-head");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        dashoffset: cs.strokeDashoffset,
        dasharray: cs.strokeDasharray,
        headOpacity: head ? getComputedStyle(head).opacity : null,
        drawn: cs.strokeDashoffset === "0px" || cs.strokeDashoffset === "0",
      };
    })(),
    glow: (() => {
      const g = document.querySelector("section img");
      if (!g) return null;
      const r = g.getBoundingClientRect();
      const cs = getComputedStyle(g);
      return {
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        width: cs.width, height: cs.height, left: cs.left, top: cs.top,
        position: cs.position, objectFit: cs.objectFit,
      };
    })(),
  };
})()`);

console.log(JSON.stringify(report, null, 2));

if (out) {
  if (FULL) {
    const { contentSize } = (
      await send("Page.getLayoutMetrics")
    ).result.cssContentSize
      ? { contentSize: (await send("Page.getLayoutMetrics")).result.cssContentSize }
      : { contentSize: (await send("Page.getLayoutMetrics")).result.contentSize };
    await send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: Math.ceil(contentSize.height),
      deviceScaleFactor: 2,
      mobile: WIDTH < 768,
    });
    // Long enough for every scroll-triggered stroke to finish drawing:
    // resizing to full height brings them all into view at once.
    await Bun.sleep(2200);
  } else {
    await send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: WIDTH < 768,
    });
    await Bun.sleep(400);
  }
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: FULL,
  });
  await Bun.write(out, Buffer.from(shot.result.data, "base64"));
  console.log(`screenshot -> ${out}`);
}

ws.close();
proc.kill();
