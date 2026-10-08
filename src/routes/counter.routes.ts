// src/routes/counter.routes.ts
import { Router } from "express";
import {
  getCounter,
  getCounterSummary,
  getStaffCounter,
  listCounters,
} from "../controllers/counter.controller";

const router = Router();

// Important: register the specific routes before /:id
router.get("/summary", getCounterSummary);
router.get("/staff/:staffId", getStaffCounter);
router.get("/:id", getCounter);
router.get("/", listCounters);

export default router;
