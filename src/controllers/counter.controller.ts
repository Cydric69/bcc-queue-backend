// src/controllers/counter.controller.ts
import { Request, Response } from "express";
import Counter from "../models/Counter";
import { manilaDate, startOfManilaDay } from "../utils/queue";

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Returns { start, end } boundaries for a Manila-time day, given a day key
 * like "2026-10-06". Falls back to today if no key is passed.
 */
function manilaDayBounds(dayKey?: string): { start: Date; end: Date } {
  const key = dayKey ?? manilaDate();

  // Start: midnight Manila on that day
  const start = new Date(`${key}T00:00:00+08:00`);
  // End: midnight Manila on the following day
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { start, end };
}

// ─── Controllers ──────────────────────────────────────────────────────────

/**
 * GET /api/counters
 * Query: ?department=cashier&day=2026-10-06
 */
export async function listCounters(req: Request, res: Response) {
  try {
    const department =
      typeof req.query.department === "string" && req.query.department
        ? req.query.department
        : undefined;

    const dayKey =
      typeof req.query.day === "string" && req.query.day
        ? req.query.day
        : manilaDate();

    const { start, end } = manilaDayBounds(dayKey);

    const filter: any = { date: { $gte: start, $lt: end } };
    if (department) filter.department = department;

    const counters = await Counter.find(filter).sort({ seq: -1 }).lean();

    // ── DEBUG ────────────────────────────────────────────────────────
    console.log(
      "[LIST]",
      "day:",
      dayKey,
      "filter:",
      JSON.stringify(filter),
      "count:",
      counters.length,
    );
    // ─────────────────────────────────────────────────────────────────

    return res.json({
      success: true,
      data: {
        day: dayKey,
        department: department ?? "all",
        counters: counters.map((c: any) => ({
          id: c._id,
          staffId: c.staffId ?? null,
          department: c.department ?? null,
          seq: c.seq ?? 0,
          date: c.date,
          transactionTypes: c.transactionTypes ?? {},
          updatedAt: c.updatedAt ?? null,
        })),
      },
    });
  } catch (err) {
    console.error("listCounters error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load counters" });
  }
}

/**
 * GET /api/counters/:id
 */
export async function getCounter(req: Request, res: Response) {
  try {
    const counter = await Counter.findById(req.params.id).lean();
    if (!counter) {
      return res
        .status(404)
        .json({ success: false, message: "Counter not found" });
    }
    return res.json({ success: true, data: counter });
  } catch (err) {
    console.error("getCounter error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load counter" });
  }
}

/**
 * GET /api/counters/staff/:staffId
 * Query: ?day=2026-10-06
 */
export async function getStaffCounter(req: Request, res: Response) {
  try {
    const { staffId } = req.params;
    const dayKey =
      typeof req.query.day === "string" && req.query.day
        ? req.query.day
        : manilaDate();

    const { start, end } = manilaDayBounds(dayKey);

    const counter = await Counter.findOne({
      staffId,
      date: { $gte: start, $lt: end },
    }).lean();

    if (!counter) {
      return res.json({
        success: true,
        data: {
          staffId,
          day: dayKey,
          seq: 0,
          department: null,
          transactionTypes: {},
          exists: false,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        id: (counter as any)._id,
        staffId,
        day: dayKey,
        seq: (counter as any).seq ?? 0,
        department: (counter as any).department ?? null,
        transactionTypes: (counter as any).transactionTypes ?? {},
        exists: true,
      },
    });
  } catch (err) {
    console.error("getStaffCounter error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load staff counter" });
  }
}

/**
 * GET /api/counters/summary
 * Query: ?day=2026-10-06
 */
export async function getCounterSummary(req: Request, res: Response) {
  try {
    const dayKey =
      typeof req.query.day === "string" && req.query.day
        ? req.query.day
        : manilaDate();

    const { start, end } = manilaDayBounds(dayKey);

    const rows = await Counter.aggregate([
      { $match: { date: { $gte: start, $lt: end } } },
      {
        $group: {
          _id: "$department",
          total: { $sum: "$seq" },
          staffCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ── DEBUG ────────────────────────────────────────────────────────
    console.log(
      "[SUMMARY]",
      "day:",
      dayKey,
      "range:",
      start.toISOString(),
      "→",
      end.toISOString(),
      "rows:",
      JSON.stringify(rows),
    );
    // ─────────────────────────────────────────────────────────────────

    const summary = rows.map((r) => ({
      department: r._id ?? "unknown",
      totalTickets: r.total ?? 0,
      staffCount: r.staffCount ?? 0,
    }));

    const grandTotal = summary.reduce((s, r) => s + r.totalTickets, 0);

    return res.json({
      success: true,
      data: {
        day: dayKey,
        byDepartment: summary,
        grandTotal,
      },
    });
  } catch (err) {
    console.error("getCounterSummary error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load counter summary" });
  }
}
