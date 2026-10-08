// src/schemas/documentRequest.schema.ts

import { Document } from "mongoose";

// ─── Enums ───────────────────────────────────────────────────────────────
export const VALID_DOCUMENT_TYPES = [
  "tor",
  "good-moral",
  "diploma",
  "certificate-of-graduation",
  "certificate-of-enrollment",
  "other",
] as const;

export const VALID_REQUEST_STATUSES = [
  "pending",
  "processing",
  "ready",
  "released",
  "rejected",
  "cancelled",
] as const;

export const VALID_STUDENT_GENDERS = ["Male", "Female", "Other", ""] as const;

export const VALID_TOR_GENDERS = ["male", "female"] as const;

export const VALID_EMPLOYMENT_SCOPES = ["local", "abroad"] as const;

export const VALID_BOARD_EXAM_TYPES = ["cpa", "let", "other"] as const;

export const VALID_SEMESTERS = ["1st", "2nd", "Summer"] as const;

// ─── Derived unions ──────────────────────────────────────────────────────
export type DocumentType = (typeof VALID_DOCUMENT_TYPES)[number];
export type RequestStatus = (typeof VALID_REQUEST_STATUSES)[number];
export type StudentGender = (typeof VALID_STUDENT_GENDERS)[number];
export type TorGender = (typeof VALID_TOR_GENDERS)[number];
export type EmploymentScope = (typeof VALID_EMPLOYMENT_SCOPES)[number];
export type BoardExamType = (typeof VALID_BOARD_EXAM_TYPES)[number];
export type Semester = (typeof VALID_SEMESTERS)[number];

// ─── Sub-document shapes ─────────────────────────────────────────────────
export interface IDocumentRequestStudent {
  schoolId: string;
  firstName: string;
  lastName: string;
  middleName: string;
  suffix: string;
  gender: StudentGender;
  birthdate: string;
  year: string;
  campus: string;
  email: string;
  contactNumber: string;
}

export interface ITorSchoolEntry {
  school: string;
  yearGraduated: string;
}

export interface ITorEducationalBackground {
  elementary: ITorSchoolEntry;
  highSchool: ITorSchoolEntry;
  seniorHigh: ITorSchoolEntry;
}

export interface ITorDetails {
  purpose: {
    employment: boolean;
    employmentScope: EmploymentScope;
    cavChed: boolean;
    cavScope: EmploymentScope;
    boardExam: boolean;
    boardExamType: BoardExamType;
    boardExamOther: string;
  };
  student: {
    lastName: string;
    firstName: string;
    middleName: string;
    birthdate: string;
    birthplace: string;
    gender: TorGender;
    address: string;
    contactNo: string;
  };
  academic: {
    course: string;
    major: string;
    yearGraduated: string;
    notGraduated: boolean;
    semester: Semester;
    schoolYear: string;
  };
  educationalBackground: ITorEducationalBackground;
  fee: number;
}

export interface IStatusHistoryEntry {
  status: string;
  timestamp: Date;
  changedBy: string;
  remarks: string;
}

// ─── Root document interface ──────────────────────────────────────────────
// Extends Mongoose's Document here so that every consumer of IDocumentRequest
// automatically gets save(), _id, isModified(), etc.
export interface IDocumentRequest extends Document {
  requestId: string;
  userId: string;
  student: IDocumentRequestStudent;
  documentType: DocumentType;
  otherDescription: string;
  purpose: string;
  copies: number;
  status: RequestStatus;
  remarks: string;
  torDetails: ITorDetails | null;
  statusHistory: IStatusHistoryEntry[];
  processedBy: string | null;
  readyAt: Date | null;
  releasedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
