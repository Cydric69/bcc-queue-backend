// src/controllers/documentRequest.controller.ts

import { Request, Response } from "express";
import DocumentRequest, {
  VALID_DOCUMENT_TYPES,
  VALID_REQUEST_STATUSES,
  type DocumentType,
  type RequestStatus,
} from "../models/DocumentRequest";
import {
  buildRequestId,
  nextRequestSequence,
} from "../utils/generateRequestId";

// ─── Helpers ────────────────────────────────────────────────────────────
function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

interface ValidationError {
  field: string;
  message: string;
}

type ValidationResult =
  | { ok: true; value: any }
  | { ok: false; errors: ValidationError[] };

function validateCreateRequest(body: any): ValidationResult {
  const errors: ValidationError[] = [];

  const student = body?.student ?? {};
  const firstName = asString(student.firstName);
  const lastName = asString(student.lastName);
  const email = asString(student.email);

  if (!firstName)
    errors.push({ field: "student.firstName", message: "Required" });
  if (!lastName)
    errors.push({ field: "student.lastName", message: "Required" });
  if (!email) {
    errors.push({ field: "student.email", message: "Required" });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: "student.email", message: "Invalid email" });
  }

  const documentType = asString(body?.documentType) as DocumentType;
  if (!VALID_DOCUMENT_TYPES.includes(documentType)) {
    errors.push({ field: "documentType", message: "Invalid document type" });
  }

  const otherDescription = asString(body?.otherDescription);
  if (documentType === "other" && !otherDescription) {
    errors.push({
      field: "otherDescription",
      message: "Description required for 'other'",
    });
  }

  const purpose = asString(body?.purpose);
  if (!purpose) errors.push({ field: "purpose", message: "Required" });
  if (purpose.length > 300) {
    errors.push({
      field: "purpose",
      message: "Must be 300 characters or fewer",
    });
  }

  const copies = asNumber(body?.copies, 1);
  if (copies < 1 || copies > 5) {
    errors.push({ field: "copies", message: "Must be between 1 and 5" });
  }

  let torDetails: any = null;
  if (documentType === "tor") {
    const t = body?.torDetails ?? {};
    const tp = t.purpose ?? {};
    const ts = t.student ?? {};
    const ta = t.academic ?? {};
    const teb = t.educationalBackground ?? {};

    if (!asString(ts.birthdate))
      errors.push({
        field: "torDetails.student.birthdate",
        message: "Required",
      });
    if (!asString(ts.address))
      errors.push({
        field: "torDetails.student.address",
        message: "Required",
      });
    if (!asString(ts.contactNo))
      errors.push({
        field: "torDetails.student.contactNo",
        message: "Required",
      });
    if (!asString(ta.course))
      errors.push({
        field: "torDetails.academic.course",
        message: "Required",
      });
    if (!asBool(ta.notGraduated) && !asString(ta.yearGraduated)) {
      errors.push({
        field: "torDetails.academic.yearGraduated",
        message: "Required unless not graduated",
      });
    }

    torDetails = {
      purpose: {
        employment: asBool(tp.employment),
        employmentScope: tp.employmentScope === "abroad" ? "abroad" : "local",
        cavChed: asBool(tp.cavChed),
        cavScope: tp.cavScope === "abroad" ? "abroad" : "local",
        boardExam: asBool(tp.boardExam),
        boardExamType:
          tp.boardExamType === "let" || tp.boardExamType === "other"
            ? tp.boardExamType
            : "cpa",
        boardExamOther: asString(tp.boardExamOther),
      },
      student: {
        lastName: asString(ts.lastName),
        firstName: asString(ts.firstName),
        middleName: asString(ts.middleName),
        birthdate: asString(ts.birthdate),
        birthplace: asString(ts.birthplace),
        gender: ts.gender === "female" ? "female" : "male",
        address: asString(ts.address),
        contactNo: asString(ts.contactNo),
      },
      academic: {
        course: asString(ta.course),
        major: asString(ta.major),
        yearGraduated: asString(ta.yearGraduated),
        notGraduated: asBool(ta.notGraduated),
        semester:
          ta.semester === "2nd" || ta.semester === "Summer"
            ? ta.semester
            : "1st",
        schoolYear: asString(ta.schoolYear),
      },
      educationalBackground: {
        elementary: {
          school: asString(teb.elementary?.school),
          yearGraduated: asString(teb.elementary?.yearGraduated),
        },
        highSchool: {
          school: asString(teb.highSchool?.school),
          yearGraduated: asString(teb.highSchool?.yearGraduated),
        },
        seniorHigh: {
          school: asString(teb.seniorHigh?.school),
          yearGraduated: asString(teb.seniorHigh?.yearGraduated),
        },
      },
      fee: 150,
    };
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      student: {
        schoolId: asString(student.schoolId),
        firstName,
        lastName,
        middleName: asString(student.middleName),
        suffix: asString(student.suffix),
        gender: ["Male", "Female", "Other"].includes(student.gender)
          ? student.gender
          : "",
        birthdate: asString(student.birthdate),
        year: asString(student.year),
        campus: asString(student.campus),
        email: email.toLowerCase(),
        contactNumber: asString(student.contactNumber),
      },
      documentType,
      otherDescription: documentType === "other" ? otherDescription : "",
      purpose,
      copies,
      torDetails,
    },
  };
}

// ─── Controllers ────────────────────────────────────────────────────────

/**
 * POST /api/document-requests
 * Body must include `userId` since there is no auth.
 */
export async function createDocumentRequest(req: Request, res: Response) {
  try {
    const userId = asString(req.body?.userId);
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });
    }

    const validation = validateCreateRequest(req.body);
    if (!validation.ok) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: validation.errors,
      });
    }

    // Allocate a unique requestId
    let requestId = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const seq = await nextRequestSequence(DocumentRequest);
      const candidate = buildRequestId(seq + attempt);
      const exists = await DocumentRequest.exists({ requestId: candidate });
      if (!exists) {
        requestId = candidate;
        break;
      }
    }
    if (!requestId) {
      return res.status(500).json({
        success: false,
        message: "Could not allocate a request ID. Try again.",
      });
    }

    const doc = await DocumentRequest.create({
      requestId,
      userId,
      ...validation.value,
      status: "pending",
      statusHistory: [
        {
          status: "pending",
          timestamp: new Date(),
          changedBy: userId,
          remarks: "Request created",
        },
      ],
    });

    return res.status(201).json({ success: true, data: doc });
  } catch (err: any) {
    console.error("createDocumentRequest error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create request" });
  }
}

/**
 * GET /api/document-requests/mine?userId=xxx
 */
export async function listMyDocumentRequests(req: Request, res: Response) {
  try {
    const userId = asString(req.query.userId);
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });
    }

    const items = await DocumentRequest.find({ userId })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({ success: true, data: items });
  } catch (err) {
    console.error("listMyDocumentRequests error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load requests" });
  }
}

/**
 * GET /api/document-requests/:id
 */
export async function getDocumentRequest(req: Request, res: Response) {
  try {
    const doc = await DocumentRequest.findOne({
      $or: [{ _id: req.params.id }, { requestId: req.params.id }],
    }).lean();

    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("getDocumentRequest error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load request" });
  }
}

/**
 * PATCH /api/document-requests/:id/status
 * Body: { status, remarks? }
 */
export async function updateDocumentRequestStatus(req: Request, res: Response) {
  try {
    const { status, remarks } = req.body ?? {};
    const allowed = VALID_REQUEST_STATUSES as readonly string[];
    if (!allowed.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid status" });
    }

    const doc = await DocumentRequest.findById(req.params.id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }

    const now = new Date();
    doc.status = status as RequestStatus;
    doc.remarks = typeof remarks === "string" ? remarks.slice(0, 500) : "";
    doc.statusHistory.push({
      status,
      timestamp: now,
      changedBy: "staff",
      remarks: doc.remarks,
    });

    if (status === "ready") doc.readyAt = now;
    if (status === "released") doc.releasedAt = now;
    if (status === "rejected") doc.rejectedAt = now;

    await doc.save();

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("updateDocumentRequestStatus error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update request" });
  }
}

/**
 * DELETE /api/document-requests/:id?userId=xxx
 */
export async function cancelDocumentRequest(req: Request, res: Response) {
  try {
    const userId = asString(req.query.userId ?? req.body?.userId);
    if (!userId) {
      return res
        .status(400)
        .json({ success: false, message: "userId is required" });
    }

    const doc = await DocumentRequest.findById(req.params.id);
    if (!doc) {
      return res
        .status(404)
        .json({ success: false, message: "Request not found" });
    }

    if (String(doc.userId) !== String(userId)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    if (doc.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending requests can be cancelled",
      });
    }

    doc.status = "cancelled";
    doc.statusHistory.push({
      status: "cancelled",
      timestamp: new Date(),
      changedBy: userId,
      remarks: "Cancelled by student",
    });
    await doc.save();

    return res.json({ success: true, data: doc });
  } catch (err) {
    console.error("cancelDocumentRequest error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to cancel request" });
  }
}

/**
 * GET /api/document-requests?status=pending&documentType=tor
 */
export async function listAllDocumentRequests(req: Request, res: Response) {
  try {
    const filter: Record<string, any> = {};
    if (typeof req.query.status === "string" && req.query.status) {
      filter.status = req.query.status;
    }
    if (typeof req.query.documentType === "string" && req.query.documentType) {
      filter.documentType = req.query.documentType;
    }

    const items = await DocumentRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.json({ success: true, data: items });
  } catch (err) {
    console.error("listAllDocumentRequests error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to load requests" });
  }
}
