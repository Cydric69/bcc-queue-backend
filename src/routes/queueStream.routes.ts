// src/routes/queueStream.routes.ts
import { Router, Request, Response } from "express";
import Ticket from "../models/Ticket";
import Counter from "../models/Counter";

const router = Router();

/**
 * GET /api/queue/stream
 * Server-Sent Events. Mirrors the Next.js implementation:
 *  - Ticket change streams → event type "ticket"
 *  - Counter change streams → event type "counter"
 *  - Heartbeat every 15s
 *  - "connected" event on open
 */
router.get("/stream", async (req: Request, res: Response) => {
  // SSE headers — disable any buffering/proxying interference
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (data: any) => {
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // socket closed
    }
  };

  let ticketStream: any = null;
  let counterStream: any = null;
  let heartbeat: NodeJS.Timeout | null = null;

  try {
    send({ type: "connected" });

    // Watch tickets
    ticketStream = Ticket.watch(
      [
        {
          $match: {
            operationType: {
              $in: ["insert", "update", "delete", "replace"],
            },
          },
        },
      ],
      { fullDocument: "updateLookup" },
    );

    ticketStream.on("change", (change: any) => {
      send({
        type: "ticket",
        operation: change.operationType,
        document: change.fullDocument,
        id: change.documentKey?._id,
      });
    });

    ticketStream.on("error", (err: any) => {
      console.error("[SSE] ticket stream error:", err?.message);
    });

    // Watch counters
    counterStream = Counter.watch(
      [
        {
          $match: {
            operationType: { $in: ["insert", "update", "replace"] },
          },
        },
      ],
      { fullDocument: "updateLookup" },
    );

    counterStream.on("change", (change: any) => {
      send({
        type: "counter",
        operation: change.operationType,
        document: change.fullDocument,
      });
    });

    counterStream.on("error", (err: any) => {
      console.error("[SSE] counter stream error:", err?.message);
    });

    heartbeat = setInterval(() => send({ type: "heartbeat" }), 15000);
  } catch (error: any) {
    console.error("[SSE] setup failed:", error?.message);
    send({
      type: "error",
      message: error?.message?.includes("change streams")
        ? "Change streams require MongoDB replica set"
        : "Stream setup failed",
    });
    res.end();
    return;
  }

  // Cleanup on client disconnect
  req.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    try {
      ticketStream?.close();
    } catch {}
    try {
      counterStream?.close();
    } catch {}
    res.end();
  });
});

export default router;
