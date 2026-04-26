import express from "express";
import cors from "cors";
import { env } from "./config/env.js";

import healthRoutes from "./routes/health.routes.js";
import fxRoutes from "./routes/fx.routes.js";
import transferRoutes from "./routes/transfer.routes.js";

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────
app.use(express.json());
app.use(
  cors({
    origin: env.corsOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// ─── Routes ──────────────────────────────────────────────────────────
app.use("/health", healthRoutes);
app.use("/api/fx", fxRoutes);
app.use("/api/transfers", transferRoutes);

export default app;
