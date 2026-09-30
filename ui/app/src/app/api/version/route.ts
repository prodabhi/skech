/**
 * Which build is live, for the app to compare with its own: a Home Screen app on an iPhone is resumed, not
 * reloaded, and can run an old build for days. Not cached, here or on the way.
 */
export function GET() {
  return Response.json({ build: process.env.NEXT_PUBLIC_BUILD_ID ?? "local" }, { headers: { "cache-control": "no-store" } });
}
