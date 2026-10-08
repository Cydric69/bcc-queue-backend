// bcc-queue-backend/src/server.ts

import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import { connectDB } from "./config/db";
import queueRoutes from "./routes/queue";
import queueStreamRoutes from "./routes/queueStream.routes";
import ticketRoutes from "./routes/ticket.routes";
import documentRequestRoutes from "./routes/documentRequest.routes";
import counterRoutes from "./routes/counter.routes";
import { errorHandler } from "./middleware/errorHandler";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    db: mongoose.connection.name ?? "disconnected",
    readyState: mongoose.connection.readyState,
  });
});

app.use("/api/public", queueRoutes);
app.use("/api/queue", queueStreamRoutes);
app.use("/api/tickets", ticketRoutes);
app.use("/api/document-requests", documentRequestRoutes);
app.use("/api/counters", counterRoutes);

// Must be LAST — catches AppError and ZodError and returns clean JSON
app.use(errorHandler);

async function main() {
  await connectDB();

  // Confirm which DB we actually connected to
  const dbName = mongoose.connection.name;
  console.log(`🗄️  Connected to DB: ${dbName}`);
  if (dbName !== "bcc-queue") {
    console.warn(
      `⚠️  Expected "bcc-queue" but connected to "${dbName}". ` +
        `Check MONGODB_URI in .env — the database name must be in the path.`,
    );
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 API listening on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
