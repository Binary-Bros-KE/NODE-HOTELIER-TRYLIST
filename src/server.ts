import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { releaseExpiredHolds } from "./modules/public-site/bookings.js";

const app = createApp();

// Online bookings whose M-Pesa hold ran out unpaid are released every few minutes.
const HOLD_SWEEP_MS = 5 * 60_000;
setInterval(() => { releaseExpiredHolds().catch((error) => console.error("Hold sweep failed:", error)); }, HOLD_SWEEP_MS).unref();

app.listen(env.PORT, () => {
  console.log("──────────────────────────────────────────────");
  console.log("  HOTELIER API — by TANZ");
  console.log(`  Environment: ${env.NODE_ENV}`);
  console.log(`  Listening on: http://localhost:${env.PORT}`);
  console.log(`  Health check: http://localhost:${env.PORT}/api/health`);
  console.log("──────────────────────────────────────────────");
});
