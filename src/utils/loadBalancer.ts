// src/utils/loadBalancer.ts
import Ticket from "../models/Ticket";
import Staff from "../models/Staff";
import { startOfManilaDay } from "./queue";

export interface WindowLoad {
  windowName: string;
  staffIds: string[];
  pending: number;
  serving: number;
  load: number;
}

/**
 * A currently-serving ticket occupies the counter and blocks the next person
 * from being called, so it costs more than a waiting ticket.
 */
export const SERVING_WEIGHT = 1.5;

/**
 * Returns the current workload for every cashier window that has at least
 * one active staff member assigned to it.
 *
 *   load = pending + serving * SERVING_WEIGHT
 */
export async function getCashierWindowLoads(): Promise<WindowLoad[]> {
  const start = startOfManilaDay();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const staffList = await Staff.find({
    roleName: "cashier",
    status: "active",
  }).lean();

  console.log(
    "[LB] active cashier staff:",
    JSON.stringify(
      (staffList as any[]).map((s) => ({
        staffId: s.staffId,
        name: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim(),
        cashierWindow: s.cashierWindow ?? null,
        status: s.status,
      })),
      null,
      2,
    ),
  );

  const byWindow = new Map<string, string[]>();
  for (const s of staffList as any[]) {
    const w = String(s.cashierWindow || "").trim();
    if (!w) continue;
    if (!byWindow.has(w)) byWindow.set(w, []);
    byWindow.get(w)!.push(s.staffId);
  }

  console.log(
    "[LB] windows found:",
    JSON.stringify(
      Array.from(byWindow.entries()).map(([w, ids]) => ({
        window: w,
        staffCount: ids.length,
        staffIds: ids,
      })),
      null,
      2,
    ),
  );

  if (byWindow.size === 0) {
    console.warn(
      "[LB] ✗ NO cashierWindow set on ANY active cashier staff — " +
        "falling back to legacy per-staff load balancing",
    );
    return [];
  }

  const tickets = await Ticket.find({
    department: "cashier",
    status: { $in: ["pending", "serving"] },
    createdAt: { $gte: start, $lt: end },
  })
    .select("status assignedTo servedBy ticketNumber createdAt")
    .lean();

  console.log(
    "[LB] active cashier tickets today:",
    JSON.stringify(
      (tickets as any[]).map((t) => ({
        ticketNumber: t.ticketNumber,
        status: t.status,
        assignedTo: t.assignedTo ?? null,
        servedBy: t.servedBy ?? null,
      })),
      null,
      2,
    ),
  );

  const loads: WindowLoad[] = [];
  for (const [windowName, staffIds] of byWindow.entries()) {
    const staffSet = new Set(staffIds);
    let pending = 0;
    let serving = 0;

    for (const t of tickets as any[]) {
      const owner = t.servedBy || t.assignedTo;
      if (!owner || !staffSet.has(owner)) continue;
      if (t.status === "serving") serving++;
      else pending++;
    }

    loads.push({
      windowName,
      staffIds,
      pending,
      serving,
      load: pending + serving * SERVING_WEIGHT,
    });
  }

  console.log(
    "[LB] computed window loads:",
    JSON.stringify(
      loads.map((l) => ({
        window: l.windowName,
        pending: l.pending,
        serving: l.serving,
        load: l.load,
      })),
      null,
      2,
    ),
  );

  return loads;
}

/**
 * Picks the window with the lowest current load. Ties are broken by:
 *   1. total ticket count (pending + serving)
 *   2. window name (deterministic)
 */
export function pickLeastLoadedWindow(loads: WindowLoad[]): WindowLoad | null {
  if (loads.length === 0) return null;
  return [...loads].sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load;
    const aTotal = a.pending + a.serving;
    const bTotal = b.pending + b.serving;
    if (aTotal !== bTotal) return aTotal - bTotal;
    return a.windowName.localeCompare(b.windowName);
  })[0];
}

/**
 * Given a chosen window, picks the individual staff member with the fewest
 * active tickets.
 */
export function pickLeastLoadedStaff(
  window: WindowLoad,
  todaysTickets: Array<{
    assignedTo?: string | null;
    servedBy?: string | null;
  }>,
): string {
  const counts = new Map<string, number>();
  for (const id of window.staffIds) counts.set(id, 0);

  for (const t of todaysTickets) {
    const owner = t.servedBy || t.assignedTo;
    if (owner && counts.has(owner)) {
      counts.set(owner, counts.get(owner)! + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[0].localeCompare(b[0]);
  })[0][0];
}

/**
 * High-level helper: which staffId should own the next cashier ticket?
 * Returns null when no cashier windows are configured, so the caller can
 * fall back to legacy per-staff load balancing.
 */
export async function chooseCashierStaffForNextTicket(): Promise<{
  staffId: string | null;
  windowName: string | null;
  reason?: "no-windows" | "no-staff";
}> {
  const loads = await getCashierWindowLoads();
  if (loads.length === 0) {
    return { staffId: null, windowName: null, reason: "no-windows" };
  }

  const target = pickLeastLoadedWindow(loads);
  if (!target) {
    return { staffId: null, windowName: null, reason: "no-staff" };
  }

  console.log(
    "[LB] ✓ picked window:",
    target.windowName,
    "load =",
    target.load,
    "staffIds =",
    target.staffIds,
  );

  const start = startOfManilaDay();
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const todaysTickets = await Ticket.find({
    department: "cashier",
    status: { $in: ["pending", "serving"] },
    createdAt: { $gte: start, $lt: end },
    $or: [
      { assignedTo: { $in: target.staffIds } },
      { servedBy: { $in: target.staffIds } },
    ],
  })
    .select("assignedTo servedBy")
    .lean();

  const staffId = pickLeastLoadedStaff(target, todaysTickets as any[]);

  console.log(
    "[LB] ✓ picked staff inside window:",
    staffId,
    "(current ticket count in window:",
    todaysTickets.length,
    ")",
  );

  return { staffId, windowName: target.windowName };
}
