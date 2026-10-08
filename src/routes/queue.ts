// routes/queue.ts
import { Router, Request, Response } from "express";
import Ticket from "../models/Ticket";
import Staff from "../models/Staff";

const router = Router();

type TicketStatus = "pending" | "serving" | "completed" | "cancelled";
const ACTIVE_STATUSES: TicketStatus[] = ["pending", "serving"];

// ─────────────────────────────────────────────────────────────────────────
// Time helpers — always use Manila time
// ─────────────────────────────────────────────────────────────────────────

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000; // +08:00

/**
 * Returns "now" as a Date whose local getters (getHours, getMinutes)
 * reflect Manila time, regardless of the server's TZ.
 */
function getManilaNow(): Date {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  return new Date(utcMs + MANILA_OFFSET_MS);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isWithinHours(
  now: Date,
  openTime: string,
  closeTime: string,
): boolean {
  if (!openTime || !closeTime) return true;
  const open = toMinutes(openTime);
  const close = toMinutes(closeTime);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (open <= close) return cur >= open && cur <= close;
  // overnight window, e.g. 22:00–02:00
  return cur >= open || cur <= close;
}

function isOnBreak(
  now: Date,
  breaks: Array<{ start: string; end: string; label?: string }> = [],
): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  return breaks.some((b) => {
    if (!b?.start || !b?.end) return false;
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    if (start <= end) return cur >= start && cur <= end;
    return cur >= start || cur <= end;
  });
}

/**
 * Determines if a counter is currently serving.
 * Reads from Staff.counterSettings when present.
 * Falls back to open when the staff has no settings doc.
 */
function computeIsOpen(now: Date, staff: any | undefined): boolean {
  const settings = staff?.counterSettings;

  // No staff assigned / no settings yet — treat as open by default
  if (!settings) return true;

  // Manually toggled off by the cashier/dean
  if (settings.isOpen === false) return false;

  // Outside the configured hours
  if (!isWithinHours(now, settings.openTime, settings.closeTime)) return false;

  // On a scheduled break
  if (isOnBreak(now, settings.breaks)) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// Builders
// ─────────────────────────────────────────────────────────────────────────

interface TicketLike {
  _id: any;
  ticketNumber?: string | number;
  transactionType?: string;
  department?: string;
  createdAt?: Date;
  status?: string;
  student?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    suffix?: string;
  };
}

function buildWaitingItem(t: TicketLike) {
  return {
    _id: String(t._id),
    ticketNumber: String(t.ticketNumber ?? ""),
    transactionType: String(t.transactionType ?? ""),
    department: String(t.department ?? ""),
    createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : "",
    status: String(t.status ?? ""),
    student: t.student
      ? {
          firstName: t.student.firstName,
          middleName: t.student.middleName,
          lastName: t.student.lastName,
          suffix: t.student.suffix,
        }
      : undefined,
  };
}

function buildDepartment({
  department,
  displayName,
  tickets,
  staff,
  now,
}: {
  department: string;
  displayName: string;
  tickets: TicketLike[];
  staff?: any;
  now: Date;
}) {
  const servingTicket = tickets.find((t) => t.status === "serving");
  const waitingTickets = tickets
    .filter((t) => t.status === "pending")
    .sort(
      (a, b) =>
        new Date(a.createdAt ?? 0).getTime() -
        new Date(b.createdAt ?? 0).getTime(),
    );

  const serving = servingTicket ? String(servingTicket.ticketNumber) : null;
  const settings = staff?.counterSettings;

  // Prefer the staff-configured hours; fall back to an "always open" hint.
  const openTime = settings?.openTime ?? null;
  const closeTime = settings?.closeTime ?? null;

  return {
    department,
    displayName,
    serving,
    waiting: waitingTickets.length,
    waitingList: waitingTickets.map(buildWaitingItem),
    isOpen: computeIsOpen(now, staff),
    openTime,
    closeTime,
    // Extra context the mobile UI can surface
    manuallyClosed: settings?.isOpen === false,
    onBreak: isOnBreak(now, settings?.breaks ?? []),
    dailyLimit: settings?.dailyLimit ?? null,
  };
}

function buildQueueStatus(
  now: Date,
  departments: Array<{ isOpen: boolean; manuallyClosed?: boolean }>,
) {
  const total = departments.length;
  const openCount = departments.filter((d) => d.isOpen).length;

  // If every counter is manually closed → "closed"
  const allManuallyClosed =
    departments.length > 0 && departments.every((d) => d.manuallyClosed);

  if (openCount > 0) {
    return {
      status: "open" as const,
      openCounters: openCount,
      totalCounters: total,
      message: `Queue is open — ${openCount}/${total} counters serving`,
    };
  }

  if (allManuallyClosed) {
    return {
      status: "closed" as const,
      openCounters: 0,
      totalCounters: total,
      message: "All counters are closed",
    };
  }

  // Nobody open, but not due to a manual toggle — must be outside hours or on break
  return {
    status: "outside-hours" as const,
    openCounters: 0,
    totalCounters: total,
    message: "Queue is outside office hours",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Snapshot builder
// ─────────────────────────────────────────────────────────────────────────

async function buildSnapshot() {
  const now = getManilaNow();

  // "Today" in Manila terms, converted back to UTC boundaries for the query.
  // This makes sure a ticket created at 11 PM Manila still counts as "today".
  const manilaMidnight = new Date(now);
  manilaMidnight.setHours(0, 0, 0, 0);
  const manilaEndOfDay = new Date(now);
  manilaEndOfDay.setHours(23, 59, 59, 999);

  // Convert Manila wall-clock back to real UTC instants for Mongo comparison.
  const startUTC = new Date(manilaMidnight.getTime() - MANILA_OFFSET_MS);
  const endUTC = new Date(manilaEndOfDay.getTime() - MANILA_OFFSET_MS);

  const windowStart = { $gte: startUTC, $lte: endUTC };
  const activeFilter = { $in: ACTIVE_STATUSES };

  // ── Dean ─────────────────────────────────────────────────────────
  const deanTickets = (await Ticket.find({
    department: "dean",
    createdAt: windowStart,
    status: activeFilter,
  })
    .populate("student")
    .lean()) as unknown as TicketLike[];

  const deanStaff = await Staff.findOne({
    roleName: "dean",
    status: "active",
  }).lean();

  const deanDept = buildDepartment({
    department: "dean",
    displayName: "Dean's Office",
    tickets: deanTickets,
    staff: deanStaff,
    now,
  });

  // ── Cashier ───────────────────────────────────────────────────────
  const cashierTickets = (await Ticket.find({
    department: "cashier",
    createdAt: windowStart,
    status: activeFilter,
  })
    .populate("student")
    .lean()) as unknown as TicketLike[];

  const cashierStaffList = await Staff.find({
    roleName: "cashier",
    status: "active",
  }).lean();

  const staffByWindow = new Map<string, any>();
  cashierStaffList.forEach((s: any) => {
    if (s.cashierWindow) staffByWindow.set(s.cashierWindow, s);
  });

  const servingTicket = cashierTickets.find((t) => t.status === "serving");
  const pendingTickets = cashierTickets.filter((t) => t.status === "pending");

  const WINDOW_COUNT = 3;
  const buckets: TicketLike[][] = Array.from(
    { length: WINDOW_COUNT },
    () => [],
  );
  pendingTickets.forEach((t, i) => {
    buckets[i % WINDOW_COUNT].push(t);
  });

  const cashierDepts = Array.from({ length: WINDOW_COUNT }, (_, i) => {
    const windowName = `Window ${i + 1}`;
    const key = `cashier-${i + 1}`;
    const bucket = [...buckets[i]];
    if (i === 0 && servingTicket) bucket.unshift(servingTicket);

    return buildDepartment({
      department: key,
      displayName: windowName,
      tickets: bucket,
      staff: staffByWindow.get(windowName),
      now,
    });
  });

  const allDepartments = [deanDept, ...cashierDepts];
  const queueStatus = buildQueueStatus(now, allDepartments);

  return {
    queueStatus,
    departments: allDepartments,
    timestamp: new Date().toISOString(), // real UTC for the client
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────

router.get("/queue-snapshot", async (_req: Request, res: Response) => {
  try {
    const payload = await buildSnapshot();
    res.json(payload);
  } catch (err: any) {
    console.error("queue-snapshot error:", err);
    res.status(500).json({ error: "Failed to build queue snapshot" });
  }
});

router.get("/queue-stream-full", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const push = async () => {
    try {
      const payload = await buildSnapshot();
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      console.error("queue-stream-full push error:", err);
    }
  };

  await push();
  const timer = setInterval(push, 3000);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
});

export default router;
