// src/utils/generateTicketNumber.ts
import Counter from "../models/Counter";
import Staff from "../models/Staff";
import SystemSetting, { SYSTEM_SETTINGS_ID } from "../models/SystemSetting";
import { startOfManilaDay } from "./queue";

export type DistributionFailureReason =
  | "queue-closed"
  | "no-staff"
  | "outside-hours"
  | "counters-closed"
  | "capacity-reached";

interface TicketNumberResult {
  success: boolean;
  error?: string;
  failureReason?: DistributionFailureReason;
  ticketNumber?: string;
  ticketId?: string;
  queuePosition?: number;
  staffId?: string;
}

const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

function manilaDateStr(d: Date = new Date()): string {
  return new Date(d.getTime() + MANILA_OFFSET_MS)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

function getAppNowMinutes(d: Date = new Date()): number {
  const manila = new Date(d.getTime() + MANILA_OFFSET_MS);
  return manila.getUTCHours() * 60 + manila.getUTCMinutes();
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isWithinHours(
  nowMin: number,
  openTime: string,
  closeTime: string,
): boolean {
  if (!openTime || !closeTime) return true;
  const open = toMinutes(openTime);
  const close = toMinutes(closeTime);
  if (open <= close) return nowMin >= open && nowMin <= close;
  return nowMin >= open || nowMin <= close;
}

function isOnBreak(
  nowMin: number,
  breaks: Array<{ start: string; end: string }> = [],
): boolean {
  return breaks.some((b) => {
    if (!b?.start || !b?.end) return false;
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    if (start <= end) return nowMin >= start && nowMin <= end;
    return nowMin >= start || nowMin <= end;
  });
}

function evaluateCounterState(
  staff: any,
  load: number,
  nowMin: number,
): { state: string; accepting: boolean; settings: any } {
  const s = staff?.counterSettings ?? {};
  const openTime = s.openTime ?? "08:00";
  const closeTime = s.closeTime ?? "17:00";
  const dailyLimit = s.dailyLimit ?? 500;
  const isOpen = s.isOpen !== false;

  if (!isOpen)
    return { state: "closed", accepting: false, settings: { dailyLimit } };
  if (!isWithinHours(nowMin, openTime, closeTime))
    return {
      state: "outside-hours",
      accepting: false,
      settings: { dailyLimit },
    };
  if (isOnBreak(nowMin, s.breaks))
    return { state: "break", accepting: false, settings: { dailyLimit } };
  if (load >= dailyLimit)
    return { state: "full", accepting: false, settings: { dailyLimit } };
  return { state: "open", accepting: true, settings: { dailyLimit } };
}

async function distributeTicketNumber(
  staffId: string,
  opts?: { maxSeq?: number },
): Promise<TicketNumberResult> {
  try {
    const staff = await Staff.findOne({ staffId });
    if (!staff) {
      return { success: false, error: "Staff not found" };
    }

    const dateStr = manilaDateStr();
    const today = startOfManilaDay();
    const counterKey = `STAFF-${staffId}-${dateStr}`;

    const filter: any = { _id: counterKey };
    if (opts?.maxSeq) {
      filter.$or = [{ seq: { $lt: opts.maxSeq } }, { seq: { $exists: false } }];
    }

    const result = await Counter.findOneAndUpdate(
      filter,
      {
        $inc: { seq: 1 },
        $setOnInsert: {
          date: today,
          staffId,
          department: (staff as any).roleName,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (!result) {
      return { success: false, error: "Failed to generate ticket number" };
    }

    const nextNumber = (result as any).seq || 1;
    const ticketNumber = String(nextNumber);
    const ticketId = `${(staff as any).roleName}-${staffId}-${dateStr}-${String(nextNumber).padStart(4, "0")}`;

    return {
      success: true,
      ticketNumber,
      ticketId,
      queuePosition: nextNumber,
      staffId,
    };
  } catch (error: any) {
    if (error.code === 11000) {
      if (opts?.maxSeq) {
        const dateStr = manilaDateStr();
        const existing = await Counter.findOne({
          _id: `STAFF-${staffId}-${dateStr}`,
        }).lean();
        if (existing && ((existing as any).seq || 0) >= opts.maxSeq) {
          return {
            success: false,
            failureReason: "capacity-reached",
            error: "This counter has reached its daily ticket limit.",
          };
        }
      }
      await new Promise((r) => setTimeout(r, 100));
      return distributeTicketNumber(staffId, opts);
    }
    console.error("Error distributing staff ticket number:", error);
    return { success: false, error: "Failed to generate ticket number." };
  }
}

export async function distributeTicketToAvailableStaff(
  department: string,
): Promise<TicketNumberResult> {
  try {
    const settings = await SystemSetting.findById(SYSTEM_SETTINGS_ID).lean();
    if ((settings as any)?.queueOpen === false) {
      return {
        success: false,
        failureReason: "queue-closed",
        error: "The queue is currently closed by the administrator.",
      };
    }

    const departmentStaff = await Staff.find({
      roleName: department,
      status: "active",
    }).lean();

    if (!departmentStaff || departmentStaff.length === 0) {
      return {
        success: false,
        failureReason: "no-staff",
        error: `No available staff in ${department} department`,
      };
    }

    const dateStr = manilaDateStr();
    const nowMinutes = getAppNowMinutes();

    const counters = await Promise.all(
      departmentStaff.map(async (staff: any) => {
        const counterKey = `STAFF-${staff.staffId}-${dateStr}`;
        const counter = await Counter.findOne({ _id: counterKey }).lean();
        const load = counter ? (counter as any).seq || 0 : 0;
        const evaluation = evaluateCounterState(staff, load, nowMinutes);
        return {
          staffId: staff.staffId,
          load,
          state: evaluation.state,
          dailyLimit: evaluation.settings.dailyLimit,
          accepting: evaluation.accepting,
        };
      }),
    );

    let eligible = counters.filter((c) => c.accepting);

    if (eligible.length === 0) {
      const states = counters.map((c) => c.state);
      if (states.every((s) => s === "outside-hours")) {
        return {
          success: false,
          failureReason: "outside-hours",
          error: "Counters are outside operating hours.",
        };
      }
      if (states.some((s) => s === "full")) {
        return {
          success: false,
          failureReason: "capacity-reached",
          error: "Today's queue has reached capacity.",
        };
      }
      return {
        success: false,
        failureReason: "counters-closed",
        error: "All counters are temporarily closed or on break.",
      };
    }

    while (eligible.length > 0) {
      const leastBusy = eligible.reduce((min, s) =>
        s.load < min.load ? s : min,
      );

      const result = await distributeTicketNumber(leastBusy.staffId, {
        maxSeq: leastBusy.dailyLimit,
      });

      if (result.failureReason !== "capacity-reached") {
        return result;
      }
      eligible = eligible.filter((c) => c.staffId !== leastBusy.staffId);
    }

    return {
      success: false,
      failureReason: "capacity-reached",
      error: "Today's queue has reached capacity.",
    };
  } catch (error: any) {
    console.error("Error distributing to available staff:", error);
    return {
      success: false,
      error: "Failed to distribute ticket to available staff",
    };
  }
}
