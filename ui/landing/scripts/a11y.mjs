/**
 * Runs axe-core against the running site over CDP. No extra dependencies, * axe is injected from a local copy.
 *
 *   bun scripts/a11y.mjs <url> <width> <axe.min.js path>
 */
const [
  url = "http://localhost:3000/",
  w = "1440",
  axePath = "axe.min.js",
] = process.argv.slice(2);

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9500 + Math.floor(Math.random() * 300);

const proc = Bun.spawn(
  [CHROME, "--headless", "--disable-gpu", `--remote-debugging-port=${PORT}`,
   `--window-size=${w},900`, "--user-data-dir=/tmp/skech-a11y-profile", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

async function endpoint() {
  for (let i = 0; i < 120; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("no devtools endpoint");
}

const ws = new WebSocket(await endpoint());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) =>
  new Promise((res) => { id++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: Number(w), height: 900, deviceScaleFactor: 1, mobile: Number(w) < 768,
});
await send("Page.navigate", { url });
await Bun.sleep(2500);

await send("Runtime.evaluate", { expression: await Bun.file(axePath).text() });
const result = await evaluate(`axe.run(document, {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
}).then(r => ({
  violations: r.violations.map(v => ({
    id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
    targets: v.nodes.slice(0, 4).map(n => n.target.join(" ")),
  })),
  passes: r.passes.length,
  incomplete: r.incomplete.map(v => v.id),
}))`);

console.log(`viewport ${w}px, ${result.passes} checks passed`);
if (!result.violations.length) console.log("violations: none");
for (const v of result.violations) {
  console.log(`\n[${v.impact}] ${v.id}, ${v.help} (${v.nodes} node${v.nodes > 1 ? "s" : ""})`);
  for (const t of v.targets) console.log(`   ${t}`);
}
if (result.incomplete.length) console.log(`\nneeds review: ${result.incomplete.join(", ")}`);

ws.close();
proc.kill();
