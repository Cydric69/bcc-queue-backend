// src/controllers/ticketController.ts
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import Ticket from "../models/Ticket";
import { createTicketSchema } from "../schemas/ticket";
import {
  distributeTicketToAvailableStaff,
  type DistributionFailureReason,
} from "../utils/generateTicketNumber";
import {
  IdempotencyConflictError,
  withIdempotency,
} from "../utils/idempotency";

const MAX_RETRIES = 3;

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

// POST /api/tickets
export async function createTicket(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const parsed = createTicketSchema.parse(req.body);
    const idempotencyKey =
      (req.header("x-idempotency-key") as string | undefined) || randomUUID();

    const department = (parsed.department ?? "cashier") as string;

    const s = parsed.student;
    const g = parsed.guardian;

    // ─── DEBUG: log exactly what arrived and what we're about to save ───
    console.log("[TICKET] incoming body:", JSON.stringify(req.body, null, 2));
    console.log("[TICKET] parsed student:", JSON.stringify(s, null, 2));
    console.log("[TICKET] parsed guardian:", JSON.stringify(g, null, 2));
    console.log("[TICKET] department:", department);
    console.log("[TICKET] requesterType:", parsed.requesterType);

    const requesterEmail =
      parsed.requesterType === "student" ? (s.email ?? "") : (g?.email ?? "");
    const requesterContact =
      parsed.requesterType === "student"
        ? (s.contactNumber ?? "")
        : (g?.contactNumber ?? "");

    try {
      const result = await withIdempotency(
        `createTicket:${idempotencyKey}`,
        async () => {
          for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            const numberResult =
              await distributeTicketToAvailableStaff(department);

            if (
              !numberResult.success ||
              !numberResult.ticketNumber ||
              !numberResult.ticketId
            ) {
              if (numberResult.failureReason) {
                return {
                  ok: false as const,
                  status: 503,
                  message:
                    FAILURE_MESSAGES[numberResult.failureReason] ||
                    numberResult.error ||
                    "Ticket creation is currently unavailable.",
                };
              }
              return {
                ok: false as const,
                status: 500,
                message:
                  numberResult.error || "Failed to generate ticket number",
              };
            }

            try {
              const now = new Date();
              const guardianData =
                parsed.requesterType === "guardian" && g
                  ? {
                      firstName: g.guardianFirstName,
                      lastName: g.guardianLastName,
                      middleName: g.guardianMiddleName ?? "",
                      relationship: g.relationship as any,
                    }
                  : undefined;

              // ─── DEBUG: what we're handing to Mongoose ───
              console.log(
                "[TICKET] Ticket.create payload:",
                JSON.stringify(
                  {
                    ticketNumber: numberResult.ticketNumber,
                    ticketId: numberResult.ticketId,
                    department,
                    transactionType: parsed.transactionType,
                    amount: department === "cashier" ? (parsed.amount ?? 0) : 0,
                    assignedTo: numberResult.staffId || null,
                    student: {
                      schoolId: s.schoolId ?? "",
                      firstName: s.firstName,
                      lastName: s.lastName,
                      middleName: s.middleName ?? "",
                      suffix: s.suffix ?? "",
                      gender: s.gender ?? "",
                      birthdate: s.birthdate,
                      year: s.year,
                      campus: s.campus,
                    },
                    requester: {
                      type: parsed.requesterType,
                      email: requesterEmail,
                      contactNumber: requesterContact,
                    },
                    guardian: guardianData,
                  },
                  null,
                  2,
                ),
              );

              const ticket = await Ticket.create({
                ticketNumber: numberResult.ticketNumber,
                ticketId: numberResult.ticketId,
                queueDate: new Date()
                  .toISOString()
                  .slice(0, 10)
                  .replace(/-/g, ""),
                transactionType: parsed.transactionType as any,
                transactionDescription:
                  parsed.transactionDescription?.trim() || undefined,
                amount: department === "cashier" ? (parsed.amount ?? 0) : 0,
                department: department as any,
                assignedTo: numberResult.staffId || null,
                student: {
                  schoolId: s.schoolId ?? "",
                  firstName: s.firstName,
                  lastName: s.lastName,
                  middleName: s.middleName ?? "",
                  suffix: (s.suffix ?? "") as any,
                  gender: (s.gender ?? "") as any,
                  birthdate: s.birthdate,
                  year: s.year as any,
                  campus: s.campus as any,
                },
                requester: {
                  type: parsed.requesterType as any,
                  email: requesterEmail,
                  contactNumber: requesterContact,
                },
                guardian: guardianData,
                status: "pending" as any,
                statusHistory: [
                  {
                    status: "pending" as any,
                    timestamp: now,
                    changedBy: "mobile-app",
                  },
                ],
              });

              return { ok: true as const, ticket };
            } catch (error: any) {
              // Duplicate key on ticketId/ticketNumber → retry
              if (error.code === 11000 && attempt < MAX_RETRIES - 1) {
                await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
                continue;
              }

              // ─── Mongoose validation failure → log every field ───
              if (error.name === "ValidationError") {
                const fieldErrors = Object.entries(error.errors).map(
                  ([path, e]: [string, any]) => ({
                    field: path,
                    kind: e.kind,
                    message: e.message,
                    value:
                      e.value === undefined
                        ? "<undefined>"
                        : typeof e.value === "object"
                          ? JSON.stringify(e.value)
                          : e.value,
                  }),
                );

                console.error(
                  "[TICKET] ✗ ValidationError on fields:",
                  JSON.stringify(fieldErrors, null, 2),
                );
                console.error("[TICKET] ✗ Full raw error:", error);

                return {
                  ok: false as const,
                  status: 400,
                  message: fieldErrors
                    .map((f) => `${f.field}: ${f.message}`)
                    .join(" | "),
                };
              }

              // ─── Any other Mongoose / DB error → log it fully ───
              console.error("[TICKET] ✗ Non-validation error:", error);

              return {
                ok: false as const,
                status: 500,
                message:
                  error?.message ||
                  "Failed to create ticket. Please try again.",
              };
            }
          }

          return {
            ok: false as const,
            status: 500,
            message: "Failed to create ticket after multiple attempts.",
          };
        },
      );

      if (!result.ok) {
        return res
          .status(result.status)
          .json({ success: false, message: result.message });
      }

      const ticket = result.ticket.toObject();
      console.log(
        "[TICKET] ✓ Created",
        ticket.ticketNumber,
        "for",
        ticket.department,
        "assigned to",
        ticket.assignedTo,
      );

      return res.status(201).json({
        success: true,
        data: {
          ticketNumber: ticket.ticketNumber,
          ticketId: ticket.ticketId,
          transactionType: ticket.transactionType,
          transactionDescription: ticket.transactionDescription,
          amount: ticket.amount,
          status: ticket.status,
          department: ticket.department,
          student: ticket.student,
          createdAt: ticket.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return res.status(409).json({
          success: false,
          message:
            "Your request is still being processed. Please wait a moment.",
        });
      }
      throw error;
    }
  } catch (err) {
    next(err);
  }
}

// GET /api/tickets/:id
export async function getTicket(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const ticket = await Ticket.findOne({ ticketId: req.params.id });
    if (!ticket) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }
    res.json({ success: true, data: ticket.toJSON() });
  } catch (err) {
    next(err);
  }
}

// GET /api/tickets
export async function listTickets(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.department) filter.department = req.query.department;
    if (req.query.status) filter.status = req.query.status;

    const limit = Math.min(Number(req.query.limit ?? 100), 200);

    const tickets = await Ticket.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);

    res.json({ success: true, data: tickets.map((t) => t.toJSON()) });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/tickets/:id
export async function updateTicket(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { status } = req.body as { status?: string };
    const allowed = ["pending", "serving", "completed", "cancelled"];

    if (!status || !allowed.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${allowed.join(", ")}`,
      });
    }

    const now = new Date();
    const patch: Record<string, unknown> = { status, updatedAt: now };
    if (status === "cancelled") patch.cancelledAt = now;
    if (status === "serving") patch.servedAt = now;
    if (status === "completed") patch.completedAt = now;

    const ticket = await Ticket.findOneAndUpdate(
      { ticketId: req.params.id },
      {
        $set: patch,
        $push: {
          statusHistory: {
            status: status as any,
            timestamp: now,
            changedBy: "mobile",
          },
        },
      },
      { new: true },
    );

    if (!ticket) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }

    res.json({ success: true, data: ticket.toJSON() });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/tickets/:id
export async function deleteTicket(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const deleted = await Ticket.findOneAndDelete({
      ticketId: req.params.id,
    });
    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Ticket not found" });
    }
    res.json({ success: true, data: { ok: true, ticketId: req.params.id } });
  } catch (err) {
    next(err);
  }
}
