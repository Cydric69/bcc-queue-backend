import Ticket from "../models/Ticket";

const PREFIX: Record<string, string> = {
  cashier: "C",
  dean: "D",
  registrar: "R",
};

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

// "2026-10-05" in Asia/Manila time
export function manilaDate(d: Date = new Date()): string {
  return new Date(d.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

// Midnight (Asia/Manila) of the day the given date falls on
export function startOfManilaDay(d: Date = new Date()): Date {
  return new Date(`${manilaDate(d)}T00:00:00+08:00`);
}

// Next number for a department, resetting daily: "C-001", "C-002", ...
export async function nextTicketNumber(department: string) {
  const prefix = PREFIX[department];
  if (!prefix) {
    throw new Error(`Unknown department: ${department}`);
  }

  const todays = await Ticket.find({
    department,
    createdAt: { $gte: startOfManilaDay() },
  })
    .select("ticketNumber -_id")
    .lean();

  const highest = todays.reduce((max, t) => {
    const n = parseInt(t.ticketNumber.match(/(\d+)$/)?.[1] ?? "0", 10);
    return n > max ? n : max;
  }, 0);

  return {
    ticketNumber: `${prefix}-${String(highest + 1).padStart(3, "0")}`,
    queueDate: manilaDate(),
  };
}
