"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/analytics";

/**
 * When the page itself breaks: say so plainly, offer a reload, and send what broke to Sentry. It renders its own
 * document, without the app's styles, so it is styled inline.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportError(error, { digest: error.digest, boundary: "global" });
  }, [error]);
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100dvh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", background: "#fff", color: "#000" }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <p style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Something went wrong.</p>
          <p style={{ fontSize: 15, color: "#6c6c70", margin: "8px 0 20px" }}>Your balance is safe on chain.</p>
          <button onClick={() => retry()} style={{ height: 48, padding: "0 24px", borderRadius: 999, border: 0, background: "#000", color: "#fff", fontSize: 16, fontWeight: 600 }} type="button">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
