/**
 * `bun run dev`: the whole stack in one terminal, one log.
 *
 *   bun run dev                  engine, relayer, app and landing
 *   bun run dev app engine       just those
 *   bun run dev --kill           first stop whatever holds their ports
 *
 * Every line is labelled with its service. Nothing starts if a port is taken:
 * it says who has it instead. When everything is listening it prints where,
 * and if one service dies the rest are stopped with it, so the stack is never
 * left half up. Ctrl-C stops everything.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { deploymentFile, type SolanaNetwork, solanaNetwork } from "../packages/contracts/solana/sdk";

type Service = { name: string; color: number; cwd: string; cmd: string[]; port: number; url: string };

const ENGINE_PORT = Number(process.env.ENGINE_PORT) || 3102;
const RELAYER_PORT = Number(process.env.RELAYER_SOLANA_PORT) || 3104;
const SERVICES: Service[] = [
  { name: "engine", color: 35, cwd: "packages/engine", cmd: ["cargo", "run", "--release", "--", "--dev"], port: ENGINE_PORT, url: `ws://localhost:${ENGINE_PORT}/ws` },
  { name: "relayer", color: 34, cwd: "packages/relayer", cmd: ["bun", "run", "dev"], port: RELAYER_PORT, url: `ws://localhost:${RELAYER_PORT}/ws` },
  { name: "app", color: 36, cwd: "ui/app", cmd: ["bun", "run", "dev"], port: 3101, url: "http://localhost:3101" },
  { name: "landing", color: 33, cwd: "ui/landing", cmd: ["bun", "run", "dev"], port: 3100, url: "http://localhost:3100" },
];

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const kill = args.includes("--kill");
const asked = args.filter((a) => !a.startsWith("--"));
const unknown = asked.filter((a) => !SERVICES.some((s) => s.name === a));
if (unknown.length) {
  console.error(`unknown service ${unknown.join(", ")}: pick from ${SERVICES.map((s) => s.name).join(", ")}`);
  process.exit(1);
}
let services = asked.length ? SERVICES.filter((s) => asked.includes(s.name)) : SERVICES;

// SKECH_SOLANA_CLUSTER picks the cluster (devnet when blank); a bad value stops here rather than in the relayer.
let net: SolanaNetwork;
try {
  net = solanaNetwork(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
// With no game on the cluster, or no key to pay its fees with, the relayer has nothing to do: it sits out and the
// app plays for practice.
const deployment = deploymentFile(net.cluster);
const hasKey = !!process.env.SOLANA_RELAYER_SECRET_KEY?.trim() || !!process.env.SOLANA_RELAYER_KEYPAIR?.trim() || (net.cluster === "localnet" && existsSync(join(homedir(), ".config/solana/id.json")));
const missing = !existsSync(join(root, deployment))
  ? `no game on ${net.cluster} (${deployment} is missing): \x1b[1mbun run deploy:solana\x1b[0m puts one there`
  : !hasKey
    ? "no relayer key: set SOLANA_RELAYER_KEYPAIR (a keypair file) in .env.local"
    : null;
let skipped = "";
if (missing && services.some((s) => s.name === "relayer")) {
  if (asked.includes("relayer")) {
    console.error(`relayer cannot start: ${missing}`);
    process.exit(1);
  }
  services = services.filter((s) => s.name !== "relayer");
  skipped = `relayer skipped: ${missing}; until then the app plays for practice`;
}

const paint = (code: number | string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
const width = Math.max(...services.map((s) => s.name.length));
const label = (s: Service) => paint(s.color, s.name.padEnd(width));
const clock = () => paint(2, new Date().toTimeString().slice(0, 8));
const say = (text: string) => console.log(`${clock()} ${" ".repeat(width)} ${text}`);
say(`network: ${paint(1, net.label)}, from SKECH_SOLANA_CLUSTER`);
if (skipped) say(paint(33, skipped));

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
const holders = (port: number) =>
  spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)
    .map((pid) => ({ pid, command: spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout.trim() }));

// Ports first: a service that cannot bind fails later and less clearly.
const taken = [];
for (const s of services) {
  if (!(await listening(s.port))) continue;
  const held = holders(s.port);
  if (kill && held.length) {
    for (const h of held) process.kill(Number(h.pid), "SIGTERM");
    say(`freed port ${s.port} (${s.name}): stopped ${held.map((h) => `${h.pid} ${h.command}`).join(", ")}`);
    continue;
  }
  taken.push(s);
  say(paint(31, `port ${s.port} (${s.name}) is taken by ${held.map((h) => `pid ${h.pid}: ${h.command}`).join(", ") || "another process"}`));
}
if (taken.length) {
  say(`stop it, or run ${paint(1, "bun run dev --kill")} to stop it for you`);
  process.exit(1);
}
if (kill) await Bun.sleep(500);

const children = new Map<Service, ChildProcess>();
let stopping = false;

function stop(code: number) {
  if (stopping) return;
  stopping = true;
  // Each service runs in its own process group, so a Next server's own children go with it.
  for (const child of children.values()) if (child.exitCode === null) signal(child, "SIGINT");
  const force = setTimeout(() => {
    for (const child of children.values()) if (child.exitCode === null) signal(child, "SIGKILL");
  }, 4000);
  const done = () => {
    if ([...children.values()].every((c) => c.exitCode !== null || c.signalCode !== null)) {
      clearTimeout(force);
      process.exit(code);
    }
  };
  for (const child of children.values()) child.once("exit", done);
  done();
}
function signal(child: ChildProcess, sig: NodeJS.Signals) {
  try {
    process.kill(-child.pid!, sig);
  } catch {}
}
process.on("SIGINT", () => (console.log(), say("stopping everything…"), stop(0)));
process.on("SIGTERM", () => stop(0));

/** Each line prefixed; a chunk that ends mid-line waits for the rest. */
function pipe(s: Service, stream: NodeJS.ReadableStream) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`${clock()} ${label(s)} ${line}`);
  });
  stream.on("end", () => rest.trim() && console.log(`${clock()} ${label(s)} ${rest}`));
}

const started = performance.now();
say(`starting ${services.map((s) => paint(s.color, s.name)).join(", ")}`);
for (const s of services) {
  const env = { ...process.env, FORCE_COLOR: "1", CARGO_TERM_COLOR: "always" };
  // PORT would move every Next app onto one port: each keeps its own default here.
  delete env.PORT;
  const child = spawn(s.cmd[0], s.cmd.slice(1), { cwd: join(root, s.cwd), env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  children.set(s, child);
  pipe(s, child.stdout!);
  pipe(s, child.stderr!);
  child.on("error", (e) => {
    console.log(`${clock()} ${label(s)} ${paint(31, `could not start ${s.cmd[0]}: ${e.message}`)}`);
    stop(1);
  });
  child.on("exit", (code, sig) => {
    if (stopping) return;
    console.log(`${clock()} ${label(s)} ${paint(31, `exited (${sig ?? `code ${code}`}); stopping everything`)}`);
    stop(code || 1);
  });
}

// Ready once every port answers; the engine's first build can take a minute.
const ready = new Set<Service>();
while (!stopping && ready.size < services.length) {
  for (const s of services) {
    if (ready.has(s) || !(await listening(s.port))) continue;
    ready.add(s);
    say(`${paint(32, "✓")} ${paint(s.color, s.name)} ready in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  }
  await Bun.sleep(250);
}
if (!stopping) {
  const rows = services.map((s) => `  ${paint(s.color, s.name.padEnd(width))}  ${s.url}`);
  console.log(["", paint(32, "  everything is up"), ...rows, paint(2, "  ctrl-c stops it all"), ""].join("\n"));
}
