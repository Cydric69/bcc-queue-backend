// src/routes/documentRequest.routes.ts

import { Router } from "express";
import {
  cancelDocumentRequest,
  createDocumentRequest,
  getDocumentRequest,
  listAllDocumentRequests,
  listMyDocumentRequests,
  updateDocumentRequestStatus,
} from "../controllers/documentRequest.controller";

const router = Router();

router.post("/", createDocumentRequest);
router.get("/mine", listMyDocumentRequests);
router.get("/", listAllDocumentRequests);
router.get("/:id", getDocumentRequest);
router.patch("/:id/status", updateDocumentRequestStatus);
router.delete("/:id", cancelDocumentRequest);

export default router;
