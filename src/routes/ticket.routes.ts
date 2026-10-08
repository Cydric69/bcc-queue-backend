// src/routes/ticket.routes.ts
import { Router } from "express";
import { z } from "zod";

import { asyncHandler } from "../middleware/asyncHandler";
import { createTicketLimiter } from "../middleware/rateLimiter";
import { validate } from "../middleware/validate";
import Ticket, { ITicket } from "../models/Ticket";
import Staff from "../models/Staff";
import { createTicketSchema, DEPARTMENT_TRANSACTIONS } from "../schemas/ticket";
import { AppError } from "../utils/AppError";
import {
  distributeTicketToAvailableStaff,
  type DistributionFailureReason,
} from "../utils/generateTicketNumber";
import {
  IdempotencyConflictError,
  withIdempotency,
} from "../utils/idempotency";
import { startOfManilaDay } from "../utils/queue";

const router = Router();

const ticketIdParam = z.object({ ticketId: z.string() });

const departmentParam = z.object({
  department: z.enum(["cashier", "dean", "registrar"]),
});

const DEPT_LABELS: Record<string, string> = {
  cashier: "Cashier",
  dean: "Dean's Office",
  registrar: "Registrar",
};

const FAILURE_MESSAGES: Record<DistributionFailureReason, string> = {
  "queue-closed":
    "The queue is currently closed by the administrator. Please try again later.",
  "outside-hours":
    "Counters are currently outside operating hours. Please come back during open hours.",
  "counters-closed":
    "All counters are temporarily closed or on break. Please try again shortly.",
  "capacity-reached":
    "Today's queue has reached its capacity. Please come back tomorrow.",
  "no-staff": "No staff are available right now. Please try again later.",
};

function fullName(s: {
  firstName: string;
  middleName?: string;
  lastName: string;
  suffix?: string;
}) {
  return [s.firstName, s.middleName, s.lastName, s.suffix]
    .filter(Boolean)
    .join(" ");
}

function staffFullName(s: any) {
  if (!s) return null;
  return [s.firstName, s.lastName].filter(Boolean).join(" ") || null;
}

// What the mobile app is allowed to see (no birthdate, contact info, etc.)
function toPublic(t: ITicket) {
  return {
    ticketId: t.ticketId,
    ticketNumber: t.ticketNumber,
    department: t.department,
    transactionType: t.transactionType,
    transactionDescription: t.transactionDescription,
    amount: t.amount,
    status: t.status,
    servingWindow: t.servingWindow,
    studentName: fullName(t.student),
    createdAt: t.createdAt,
    servedAt: t.servedAt,
    completedAt: t.completedAt,
    cancelledAt: t.cancelledAt,
  };
}

async function getQueueInfo(t: ITicket) {
  const [peopleAhead, serving] = await Promise.all([
    t.status === "pending"
      ? Ticket.countDocuments({
          department: t.department,
          status: "pending",
          createdAt: { $gte: startOfManilaDay(t.createdAt), $lt: t.createdAt },
        })
      : Promise.resolve(0),
    Ticket.findOne({ department: t.department, status: "serving" })
      .sort({ servedAt: -1 })
      .select("ticketNumber servingWindow"),
  ]);

  return {
    peopleAhead,
    nowServing: serving
      ? { ticketNumber: serving.ticketNumber, window: serving.servingWindow }
      : null,
  };
}

// ─── GET /api/tickets/live ─────────────────────────────────────────────────
// Full live queue with staff per cashier window.
// Only Cashier and Dean are returned (Registrar uses a separate request flow).
// Must be registered BEFORE "/:ticketId" so the dynamic matcher doesn't grab it.
router.get(
  "/live",
  asyncHandler(async (_req, res) => {
    const departments = ["cashier", "dean"] as const;

    const start = startOfManilaDay();
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const result = await Promise.all(
      departments.map(async (dept) => {
        // All active staff for this department
        const staffList = await Staff.find({
          roleName: dept,
          status: "active",
        }).lean();

        // All active tickets today for this department
        const tickets = await Ticket.find({
          department: dept,
          status: { $in: ["pending", "serving"] },
          createdAt: { $gte: start, $lt: end },
        })
          .sort({ createdAt: 1 })
          .lean();

        // ── Cashier → split into windows ────────────────────────────
        if (dept === "cashier") {
          const windows: Record<string, any> = {};

          // Only create windows from staff who actually have a cashierWindow set
          for (const s of staffList as any[]) {
            const windowName = String(s.cashierWindow || "").trim();
            if (!windowName) continue; // skip staff without a window

            if (!windows[windowName]) {
              windows[windowName] = {
                window: windowName,
                staff: null,
                serving: null,
                waiting: [],
              };
            }
            windows[windowName].staff = {
              staffId: s.staffId,
              name: staffFullName(s),
            };
          }

          // If nobody has a window set, fall back to Window 1 / 2 / 3 placeholders
          if (Object.keys(windows).length === 0) {
            for (let i = 1; i <= 3; i++) {
              const name = `Window ${i}`;
              windows[name] = {
                window: name,
                staff: null,
                serving: null,
                waiting: [],
              };
            }
          }

          // Distribute tickets into their window buckets
          for (const t of tickets as any[]) {
            const ownerId = t.servedBy || t.assignedTo;
            const owner = (staffList as any[]).find(
              (s) => s.staffId === ownerId,
            );
            const windowName = String(owner?.cashierWindow || "").trim();
            if (!windowName || !windows[windowName]) continue; // skip unassigned

            const ticketPayload = {
              ticketNumber: t.ticketNumber,
              ticketId: t.ticketId,
              transactionType: t.transactionType,
              student: t.student,
            };

            if (t.status === "serving") {
              windows[windowName].serving = ticketPayload;
            } else {
              windows[windowName].waiting.push(ticketPayload);
            }
          }

          // Sort: Window 1, Window 2, Window 3, then anything else alphabetically
          const ordered = Object.values(windows).sort((a: any, b: any) => {
            const na = parseInt(String(a.window).replace(/\D/g, ""), 10) || 999;
            const nb = parseInt(String(b.window).replace(/\D/g, ""), 10) || 999;
            if (na !== nb) return na - nb;
            return String(a.window).localeCompare(String(b.window));
          });

          const totalServing = ordered.filter((w: any) => w.serving).length;
          const totalWaiting = ordered.reduce(
            (sum: number, w: any) => sum + w.waiting.length,
            0,
          );

          return {
            department: "cashier" as const,
            displayName: "Cashier",
            windows: ordered,
            totalServing,
            totalWaiting,
          };
        }

        // ── Dean → single lane ──────────────────────────────────────
        const servingTicket = (tickets as any[]).find(
          (t) => t.status === "serving",
        );
        const waitingTickets = (tickets as any[]).filter(
          (t) => t.status === "pending",
        );

        const onDuty = (staffList as any[]).map((s) => ({
          staffId: s.staffId,
          name: staffFullName(s),
        }));

        const servingStaff = servingTicket?.servedBy
          ? (staffList as any[]).find(
              (s) => s.staffId === servingTicket.servedBy,
            )
          : null;

        return {
          department: "dean" as const,
          displayName: "Dean's Office",
          staff: onDuty,
          serving: servingTicket
            ? {
                ticketNumber: servingTicket.ticketNumber,
                ticketId: servingTicket.ticketId,
                transactionType: servingTicket.transactionType,
                student: servingTicket.student,
                staffName: staffFullName(servingStaff),
              }
            : null,
          waiting: waitingTickets.map((t: any) => ({
            ticketNumber: t.ticketNumber,
            ticketId: t.ticketId,
            transactionType: t.transactionType,
            student: t.student,
          })),
        };
      }),
    );

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        departments: result,
      },
    });
  }),
);

// GET /api/tickets/queue/:department — who is being served + how many wait
router.get(
  "/queue/:department",
  validate(departmentParam, "params"),
  asyncHandler(async (_req, res) => {
    const { department } = res.locals.validated.params as {
      department: string;
    };

    const [serving, waiting] = await Promise.all([
      Ticket.find({ department, status: "serving" })
        .sort({ servedAt: 1 })
        .select("ticketNumber servingWindow -_id"),
      Ticket.countDocuments({
        department,
        status: "pending",
        createdAt: { $gte: startOfManilaDay() },
      }),
    ]);

    res.json({
      success: true,
      data: {
        department,
        nowServing: serving.map((t) => ({
          ticketNumber: t.ticketNumber,
          window: t.servingWindow,
        })),
        waiting,
      },
    });
  }),
);

// POST /api/tickets — create a ticket (counter-based, matches web app)
router.post(
  "/",
  createTicketLimiter,
  validate(createTicketSchema),
  asyncHandler(async (req, res) => {
    const {
      student,
      requesterType,
      guardian,
      department,
      transactionType,
      transactionDescription,
      amount,
    } = req.body;

    // The transaction must belong to the chosen department
    const allowed = DEPARTMENT_TRANSACTIONS[department];
    if (!allowed || !allowed.includes(transactionType)) {
      throw new AppError(
        "That transaction is not available for this department.",
        400,
      );
    }

    // Zod keeps email/contact inside student or guardian; the model keeps them in requester
    const contact = requesterType === "guardian" ? guardian : student;
    const email = contact?.email?.trim().toLowerCase();
    if (!email) {
      throw new AppError("Email is required to get a queue number.", 400);
    }

    // One active ticket per email (any department) per day
    const active = await Ticket.findOne({
      "requester.email": email,
      status: { $in: ["pending", "serving"] },
      createdAt: { $gte: startOfManilaDay() },
    }).select("ticketNumber department");

    if (active) {
      throw new AppError(
        `You already have an active ticket (${active.ticketNumber} at ${
          DEPT_LABELS[active.department] ?? active.department
        }). Finish or cancel it before getting another.`,
        409,
      );
    }

    const { email: _se, contactNumber: _sc, ...studentDoc } = student;

    // Idempotency key from header, or generate one
    const idempotencyKey =
      (req.header("x-idempotency-key") as string | undefined) ||
      `${email}:${department}:${transactionType}`;

    try {
      const ticket = await withIdempotency(
        `createTicket:${idempotencyKey}`,
        async () => {
          const MAX_RETRIES = 3;
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const numberResult =
              await distributeTicketToAvailableStaff(department);

            if (
              !numberResult.success ||
              !numberResult.ticketNumber ||
              !numberResult.ticketId
            ) {
              if (numberResult.failureReason) {
                throw new AppError(
                  FAILURE_MESSAGES[numberResult.failureReason] ||
                    numberResult.error ||
                    "Ticket creation is currently unavailable.",
                  503,
                );
              }
              throw new AppError(
                numberResult.error || "Failed to generate ticket number",
                500,
              );
            }

            try {
              const created = await Ticket.create({
                ticketNumber: numberResult.ticketNumber,
                ticketId: numberResult.ticketId,
                queueDate: new Date()
                  .toISOString()
                  .slice(0, 10)
                  .replace(/-/g, ""),
                transactionType,
                transactionDescription: transactionDescription || undefined,
                amount: department === "cashier" ? (amount ?? 0) : 0,
                department,
                assignedTo: numberResult.staffId || null,
                status: "pending",
                student: studentDoc,
                requester: {
                  type: requesterType,
                  email,
                  contactNumber: contact?.contactNumber ?? "",
                },
                guardian:
                  requesterType === "guardian" && guardian
                    ? {
                        firstName: guardian.guardianFirstName,
                        lastName: guardian.guardianLastName,
                        middleName: guardian.guardianMiddleName ?? "",
                        relationship: guardian.relationship,
                      }
                    : undefined,
                statusHistory: [
                  {
                    status: "pending",
                    timestamp: new Date(),
                    changedBy: "mobile-app",
                  },
                ],
              });

              return created;
            } catch (err) {
              const e = err as {
                code?: number;
                keyPattern?: Record<string, number>;
              };
              if (
                e.code === 11000 &&
                (e.keyPattern?.ticketId || e.keyPattern?.ticketNumber) &&
                attempt < MAX_RETRIES - 1
              ) {
                await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
                continue;
              }
              throw err;
            }
          }

          throw new AppError("The queue is busy. Please try again.", 503);
        },
      );

      res.status(201).json({
        success: true,
        data: { ...toPublic(ticket), ...(await getQueueInfo(ticket)) },
      });
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new AppError(
          "Your request is still being processed. Please wait a moment.",
          409,
        );
      }
      throw err;
    }
  }),
);

// GET /api/tickets/:ticketId — live status (the app polls this)
router.get(
  "/:ticketId",
  validate(ticketIdParam, "params"),
  asyncHandler(async (_req, res) => {
    const { ticketId } = res.locals.validated.params as { ticketId: string };

    const ticket = await Ticket.findOne({ ticketId });
    if (!ticket) throw new AppError("Ticket not found", 404);

    res.json({
      success: true,
      data: { ...toPublic(ticket), ...(await getQueueInfo(ticket)) },
    });
  }),
);

// PATCH /api/tickets/:ticketId/cancel — student cancels while still waiting
router.patch(
  "/:ticketId/cancel",
  validate(ticketIdParam, "params"),
  asyncHandler(async (_req, res) => {
    const { ticketId } = res.locals.validated.params as { ticketId: string };
    const now = new Date();

    const ticket = await Ticket.findOneAndUpdate(
      { ticketId, status: "pending" },
      {
        $set: { status: "cancelled", cancelledAt: now },
        $push: {
          statusHistory: {
            status: "cancelled",
            timestamp: now,
            changedBy: "student",
          },
        },
      },
      { new: true },
    );

    if (!ticket) {
      const exists = await Ticket.exists({ ticketId });
      if (!exists) throw new AppError("Ticket not found", 404);
      throw new AppError("Only waiting tickets can be cancelled.", 409);
    }

    res.json({ success: true, data: toPublic(ticket) });
  }),
);

export default router;
