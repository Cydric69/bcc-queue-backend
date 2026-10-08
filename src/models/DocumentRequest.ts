// src/models/DocumentRequest.ts

import mongoose, { Model } from "mongoose";
import {
  VALID_DOCUMENT_TYPES,
  VALID_REQUEST_STATUSES,
  VALID_STUDENT_GENDERS,
  VALID_TOR_GENDERS,
  VALID_EMPLOYMENT_SCOPES,
  VALID_BOARD_EXAM_TYPES,
  VALID_SEMESTERS,
  type IDocumentRequest,
} from "../schemas/documentRequest.schema";

// Re-export everything so consumers can import from either path
export * from "../schemas/documentRequest.schema";

// ─── Schema ───────────────────────────────────────────────────────────────
const documentRequestSchema = new mongoose.Schema<IDocumentRequest>(
  {
    requestId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },

    // ── Student snapshot ───────────────────────────────────────────────
    student: {
      schoolId: { type: String, default: "" },
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, required: true, trim: true },
      middleName: { type: String, default: "", trim: true },
      suffix: { type: String, default: "", trim: true },
      gender: {
        type: String,
        enum: VALID_STUDENT_GENDERS,
        default: "",
      },
      birthdate: { type: String, default: "" },
      year: { type: String, default: "" },
      campus: { type: String, default: "" },
      email: {
        type: String,
        default: "",
        lowercase: true,
        trim: true,
        match: [
          /^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/,
          "Please enter a valid email address",
        ],
      },
      contactNumber: { type: String, default: "" },
    },

    // ── Request ────────────────────────────────────────────────────────
    documentType: {
      type: String,
      required: true,
      enum: VALID_DOCUMENT_TYPES,
    },
    otherDescription: {
      type: String,
      default: "",
      maxlength: 200,
    },
    purpose: {
      type: String,
      required: true,
      maxlength: 300,
    },
    copies: {
      type: Number,
      default: 1,
      min: 1,
      max: 5,
    },

    // ── TOR details ────────────────────────────────────────────────────
    torDetails: {
      type: {
        purpose: {
          employment: { type: Boolean, default: false },
          employmentScope: {
            type: String,
            enum: VALID_EMPLOYMENT_SCOPES,
            default: "local",
          },
          cavChed: { type: Boolean, default: false },
          cavScope: {
            type: String,
            enum: VALID_EMPLOYMENT_SCOPES,
            default: "local",
          },
          boardExam: { type: Boolean, default: false },
          boardExamType: {
            type: String,
            enum: VALID_BOARD_EXAM_TYPES,
            default: "cpa",
          },
          boardExamOther: { type: String, default: "" },
        },
        student: {
          lastName: { type: String, default: "" },
          firstName: { type: String, default: "" },
          middleName: { type: String, default: "" },
          birthdate: { type: String, default: "" },
          birthplace: { type: String, default: "" },
          gender: {
            type: String,
            enum: VALID_TOR_GENDERS,
            default: "male",
          },
          address: { type: String, default: "" },
          contactNo: { type: String, default: "" },
        },
        academic: {
          course: { type: String, default: "" },
          major: { type: String, default: "" },
          yearGraduated: { type: String, default: "" },
          notGraduated: { type: Boolean, default: false },
          semester: {
            type: String,
            enum: VALID_SEMESTERS,
            default: "1st",
          },
          schoolYear: { type: String, default: "" },
        },
        educationalBackground: {
          elementary: {
            school: { type: String, default: "" },
            yearGraduated: { type: String, default: "" },
          },
          highSchool: {
            school: { type: String, default: "" },
            yearGraduated: { type: String, default: "" },
          },
          seniorHigh: {
            school: { type: String, default: "" },
            yearGraduated: { type: String, default: "" },
          },
        },
        fee: { type: Number, default: 0, min: 0 },
      },
      default: null,
    },

    // ── Status + audit ─────────────────────────────────────────────────
    status: {
      type: String,
      enum: VALID_REQUEST_STATUSES,
      default: "pending",
      index: true,
    },
    remarks: {
      type: String,
      default: "",
      maxlength: 500,
    },
    statusHistory: {
      type: [
        {
          _id: false,
          status: { type: String, required: true },
          timestamp: { type: Date, default: Date.now },
          changedBy: { type: String, default: "system" },
          remarks: { type: String, default: "" },
        },
      ],
      default: [],
    },
    processedBy: { type: String, default: null },
    readyAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret: any) => {
        ret.id = ret._id;
        delete ret._id;
        return ret;
      },
    },
  },
);

// ─── Indexes ──────────────────────────────────────────────────────────────
documentRequestSchema.index({ userId: 1, createdAt: -1 });
documentRequestSchema.index({ status: 1, createdAt: -1 });
documentRequestSchema.index({ documentType: 1, createdAt: -1 });

// ─── Hooks (no `next` param, no `next()` call) ───────────────────────────
documentRequestSchema.pre("save", function () {
  if (this.isNew && this.statusHistory.length === 0) {
    this.statusHistory.push({
      status: this.status || "pending",
      timestamp: new Date(),
      changedBy: "system",
      remarks: "Request created",
    });
  }
});

documentRequestSchema.pre("save", function () {
  const now = new Date();
  if (this.isModified("status")) {
    if (this.status === "ready" && !this.readyAt) this.readyAt = now;
    if (this.status === "released" && !this.releasedAt) this.releasedAt = now;
    if (this.status === "rejected" && !this.rejectedAt) this.rejectedAt = now;
  }
});

// ─── Virtuals ─────────────────────────────────────────────────────────────
documentRequestSchema.virtual("isFinal").get(function () {
  return ["released", "rejected", "cancelled"].includes(this.status);
});

documentRequestSchema.virtual("totalFee").get(function () {
  const fee = this.torDetails?.fee ?? 0;
  return fee * (this.copies || 1);
});

// ─── Model ────────────────────────────────────────────────────────────────
if (mongoose.models.DocumentRequest) {
  delete mongoose.models.DocumentRequest;
}

const DocumentRequest: Model<IDocumentRequest> =
  mongoose.model<IDocumentRequest>("DocumentRequest", documentRequestSchema);

export default DocumentRequest;
