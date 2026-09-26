import path from "node:path";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Application } from "express";
import helmet from "helmet";
import morgan from "morgan";

import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { notFound } from "./middleware/notFound.js";
import { tenantContext } from "./middleware/tenantContext.js";
import { router } from "./routes/index.js";
import { platformRouter } from "./modules/platform/platform.routes.js";
import { publicReceiptsRouter } from "./modules/public-receipts/public-receipts.routes.js";
import { downloadsRouter } from "./modules/downloads/downloads.routes.js";
import { mpesaCallbackRouter } from "./modules/mpesa/mpesa-callback.routes.js";

export function createApp(): Application {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      // In production every tenant (and the platform admin app) is served
      // from its own subdomain of APP_DOMAIN, so the allowed origin can't
      // be a single fixed string — it's any of CORS_ORIGINS (dev, one per
      // local Vite server: REACT, the platform admin app, ...) or any host
      // under APP_DOMAIN.
      origin(origin, callback) {
        if (!origin) { callback(null, true); return; } // non-browser clients (curl, health checks)
        if (env.CORS_ORIGINS.includes(origin)) { callback(null, true); return; }
        if (env.APP_DOMAIN) {
          const host = new URL(origin).hostname;
          if (host === env.APP_DOMAIN || host.endsWith(`.${env.APP_DOMAIN}`)) { callback(null, true); return; }
        }
        callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
    })
  );

  if (env.NODE_ENV === "development") {
    app.use(morgan("dev"));
  }

  app.use(express.json());
  app.use(cookieParser());

  // Scoped CORP relaxation: the global helmet() above defaults to
  // Cross-Origin-Resource-Policy: same-origin, which would silently block
  // <img src> loading an uploaded logo when the frontend is served from a
  // different origin/subdomain than the API (true even in dev: :5173 vs
  // :4000). This second helmet() call only changes that one header, only
  // for /uploads responses — every other route keeps the strict default.
  app.use(
    "/uploads",
    helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }),
    express.static(path.resolve(process.cwd(), "uploads"), { immutable: true, maxAge: "365d" })
  );

  // Mounted standalone, before tenantContext — this surface has no tenant
  // of its own (it's what CREATES tenants) and is gated only by its own
  // shared-key middleware, never x-tenant-id.
  app.use("/api/platform", platformRouter);

  // Public receipt pages — identified by a globally-unique token, so no tenant
  // header and no auth. Must sit before tenantContext.
  app.use("/public/receipts", publicReceiptsRouter);

  // server.hoteliermanagement.app/download/print-bridge — same "no tenant"
  // reasoning as above.
  app.use("/download", downloadsRouter);

  // Safaricom's STK push callback — identified by its own globally-unique
  // CheckoutRequestID, same "no tenant header" reasoning as public-receipts.
  app.use("/public/mpesa", mpesaCallbackRouter);

  app.use(tenantContext);

  app.use("/api", router);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
