// The server's errors: a page or the share image failing to render (loaded by src/instrumentation.ts).
import * as Sentry from "@sentry/nextjs";
import { SENTRY_DATA, SENTRY_DSN, SENTRY_ENVIRONMENT, SENTRY_ON, SENTRY_TRACES } from "@/lib/sentry";

Sentry.init({
  dsn: SENTRY_DSN,
  enabled: SENTRY_ON,
  environment: SENTRY_ENVIRONMENT,
  tracesSampleRate: SENTRY_TRACES,
  dataCollection: SENTRY_DATA,
});
