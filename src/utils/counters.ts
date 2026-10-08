import Staff, { ICounterSettings } from "../models/Staff";
import Ticket from "../models/Ticket";
import { AppError } from "./AppError";
import { startOfManilaDay } from "./queue";

// Departments whose counters decide whether tickets can be created.
// Add "dean" or "registrar" here to enforce them too.
const ENFORCED = ["cashier"];

const LABELS: Record<string, string> = {
  cashier: "The Cashier",
  dean: "The Dean's Office",
  registrar: "The Registrar",
};

// Same defaults as the Staff model (old documents may lack counterSettings)
const DEFAULTS: ICounterSettings = {
  isOpen: true,
  openTime: "08:00",
  closeTime: "17:00",
  breaks: [],
  dailyLimit: 500,
};

// Minutes since midnight, Asia/Manila
function manilaNowMinutes(): number {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function toMinutes(hhmm: string, fallback: number): number {
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : fallback;
}

type State =
  | { kind: "open" }
  | { kind: "closed" }
  | { kind: "outside" }
  | { kind: "break"; label: string; until: string };

function counterState(c: ICounterSettings, now: number): State {
  if (!c.isOpen) return { kind: "closed" };

  if (now < toMinutes(c.openTime, 480) || now >= toMinutes(c.closeTime, 1020)) {
    return { kind: "outside" };
  }

  const onBreak = c.breaks.find(
    (b) => now >= toMinutes(b.start, 0) && now < toMinutes(b.end, 0),
  );
  if (onBreak) {
    return {
      kind: "break",
      label: onBreak.label || "break",
      until: onBreak.end,
    };
  }

  return { kind: "open" };
}

// Throws a friendly AppError if the department cannot take new tickets
export async function assertDepartmentAccepting(department: string) {
  if (!ENFORCED.includes(department)) return;

  const name = LABELS[department] ?? department;

  const staff = await Staff.find({ roleName: department, status: "active" })
    .select("counterSettings")
    .lean();

  if (staff.length === 0) {
    throw new AppError(`${name} is not available right now.`, 403);
  }

  const counters: ICounterSettings[] = staff.map((s) => ({
    ...DEFAULTS,
    ...(s.counterSettings ?? {}),
    breaks: s.counterSettings?.breaks ?? [],
  }));

  const now = manilaNowMinutes();
  const states = counters.map((c) => counterState(c, now));
  const openCounters = counters.filter((_, i) => states[i].kind === "open");

  if (openCounters.length === 0) {
    const brk = states.find((s) => s.kind === "break");
    if (brk && brk.kind === "break") {
      throw new AppError(`${name} is on ${brk.label} until ${brk.until}.`, 403);
    }

    if (states.some((s) => s.kind === "outside")) {
      const opens = counters.map((c) => c.openTime).sort()[0];
      const closes = counters
        .map((c) => c.closeTime)
        .sort()
        .pop();
      throw new AppError(`${name} is open from ${opens} to ${closes}.`, 403);
    }

    throw new AppError(`${name} is currently closed.`, 403);
  }

  const limit = openCounters.reduce((sum, c) => sum + c.dailyLimit, 0);
  const issued = await Ticket.countDocuments({
    department,
    status: { $ne: "cancelled" },
    createdAt: { $gte: startOfManilaDay() },
  });

  if (issued >= limit) {
    throw new AppError(
      `${name} has reached today's ticket limit. Please come back tomorrow.`,
      403,
    );
  }
}
