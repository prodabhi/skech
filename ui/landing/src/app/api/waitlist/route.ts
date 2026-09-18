/**
 * The waitlist, appended to a Google Sheet.
 *
 * The sheet is written through an Apps Script web app rather than the Sheets
 * API, because that needs no service account, no OAuth and no key to rotate.
 * See ui/landing/WAITLIST.md for the script and how to deploy it.
 *
 * The endpoint stays server-side (WAITLIST_SHEET_URL, not NEXT_PUBLIC_). An
 * Apps Script web app deployed as "anyone" is an open write endpoint, and
 * shipping its URL to the browser hands anyone a direct line to the sheet.
 */
const ENDPOINT = process.env.WAITLIST_SHEET_URL;

/**
 * Deliberately permissive. Real addresses break every clever pattern, and the
 * confirmation email is the only test that actually proves one works, so this
 * only catches the obvious typo before it reaches the sheet.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * A cell that starts with one of these is a formula to a spreadsheet, and the
 * sheet is opened by people: `=HYPERLINK(...)` would be a live link in it. No
 * address anyone uses starts with one.
 */
const FORMULA = /^[=+\-@]/;

/**
 * Sign-ups from one address, at most this many in the window: enough for a
 * household behind one router, too few to fill the sheet.
 *
 * Counted in this instance's memory, so it is a speed bump, not a wall: each
 * serverless instance keeps its own count and a cold start forgets it. A
 * shared store (Vercel's firewall, or KV) is the fix if the sheet is ever
 * flooded for real.
 */
const PER_WINDOW = 5;
const WINDOW_MS = 10 * 60_000;
const recent = new Map<string, { count: number; until: number }>();

function tooMany(ip: string) {
  const now = Date.now();
  // Forget windows that are over before the map can grow without end.
  if (recent.size > 10_000) for (const [k, v] of recent) if (v.until <= now) recent.delete(k);
  const hit = recent.get(ip);
  if (!hit || hit.until <= now) {
    recent.set(ip, { count: 1, until: now + WINDOW_MS });
    return false;
  }
  hit.count++;
  return hit.count > PER_WINDOW;
}

/** The visitor's address, as the platform in front of us reports it. */
const ipOf = (request: Request) =>
  request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
  request.headers.get("x-real-ip") ||
  "unknown";

export async function POST(request: Request) {
  if (tooMany(ipOf(request))) {
    return Response.json(
      { error: "That's a lot of sign-ups. Try again in a few minutes." },
      { status: 429 },
    );
  }

  let email: unknown;
  try {
    ({ email } = await request.json());
  } catch {
    return Response.json({ error: "Malformed request." }, { status: 400 });
  }

  if (
    typeof email !== "string" ||
    !LOOKS_LIKE_EMAIL.test(email.trim()) ||
    FORMULA.test(email.trim())
  ) {
    return Response.json(
      { error: "That doesn't look like an email address." },
      { status: 400 },
    );
  }

  if (!ENDPOINT) {
    // Loud on the server, vague to the visitor: a missing deploy step is our
    // problem, and "not configured" tells a stranger about our plumbing. The
    // address itself stays out of the logs, which are kept and read elsewhere.
    console.error("WAITLIST_SHEET_URL is not set; a sign-up was dropped");
    return Response.json(
      { error: "Sign-ups aren't open yet. Try again shortly." },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        source: "landing",
        at: new Date().toISOString(),
      }),
      // Apps Script is not fast and not always up. Better a clear failure the
      // visitor can retry than a request that hangs until the tab gives up.
      signal: AbortSignal.timeout(8000),
    });
    // Apps Script always answers 200. ContentService cannot set a status
    // code, so a script that threw still arrives here looking healthy and the
    // only evidence of failure is in the body. Checking `res.ok` alone would
    // tell someone they are on the list when nothing was written.
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) {
      throw new Error(
        `sheet responded ${res.status}: ${body ? JSON.stringify(body) : "unparseable"}`,
      );
    }
  } catch (cause) {
    console.error("waitlist append failed:", cause);
    return Response.json(
      { error: "Couldn't save that just now. Try again?" },
      { status: 502 },
    );
  }

  return Response.json({ ok: true });
}
