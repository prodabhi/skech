// Runs before the app is interactive: analytics and error capture start here, so a crash on load is still seen.
import * as Sentry from "@sentry/nextjs";
import { SIGN_IN_PANEL, standalone, startAnalytics, whenIdle } from "@/lib/analytics";
import { SENTRY_APP_KEY, SENTRY_DATA, SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_ON } from "@/lib/sentry";

try {
  /*
    Errors only in the browser, no traces: no sample rate, and none of the tracing integration's observers and
    patched fetches running in a game that draws every frame. PostHog has how the app is used; the server still
    traces (sentry.server.config.ts).
  */
  Sentry.init({
    dsn: SENTRY_DSN,
    enabled: SENTRY_ON,
    environment: SENTRY_ENVIRONMENT,
    // No replay of a visit that went fine; the last minute before every error.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1,
    dataCollection: SENTRY_DATA,
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== "BrowserTracing"),
      // An error whose every frame is outside our bundle is an extension's or an injected script's, not ours.
      Sentry.thirdPartyErrorFilterIntegration({ filterKeys: [SENTRY_APP_KEY], behaviour: "drop-error-if-exclusively-contains-third-party-frames" }),
    ],
    ignoreErrors: [
      // The browser's notice that a resize took two frames, harmless and everywhere.
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
    ],
    denyUrls: [/^chrome-extension:\/\//, /^moz-extension:\/\//, /^safari-(web-)?extension:\/\//],
    // On every error: which network, and whether it was opened from the Home Screen.
    initialScope: {
      tags: {
        network: process.env.NEXT_PUBLIC_SOLANA_CLUSTER || "devnet",
        standalone: standalone(),
      },
    },
  });
  /*
    The replay's recorder is most of what Sentry weighs (about 165 KB gzipped): added once the page has painted
    and the browser is idle, not before the game can be seen. An error before then is sent without a replay.
    What is typed (the sign-in email, its code, an amount) is never in a replay, nor who is playing
    (src/lib/analytics.ts).
  */
  if (SENTRY_ON)
    whenIdle(
      () =>
        void import("@sentry/nextjs").then(
          ({ replayIntegration }) => Sentry.addIntegration(replayIntegration({ maskAllText: false, maskAllInputs: true, blockAllMedia: false, mask: [SIGN_IN_PANEL] })),
          () => undefined,
        ),
    );
} catch {
  // Nor is error capture.
}

try {
  startAnalytics();
} catch {
  // Analytics must never be the reason the game does not open.
}
