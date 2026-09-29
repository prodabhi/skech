/** An RPC URL fit for a log: its host, not the token a private endpoint carries in its path or query. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 || u.search ? "/…" : ""}`;
  } catch {
    return "<rpc>";
  }
}
