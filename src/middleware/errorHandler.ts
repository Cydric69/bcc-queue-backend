import type { ErrorRequestHandler, RequestHandler } from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";

import { AppError } from "../utils/AppError";

// 404 for unknown routes (register after all routes)
export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

// Central error handler (register last)
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let statusCode = 500;
  let message = "Something went wrong. Please try again.";
  let errors: { field: string; message: string }[] | undefined;

  if (err instanceof ZodError) {
    statusCode = 400;
    message = "Validation failed";
    errors = err.issues.map((i) => ({
      field: i.path.join("."),
      message: i.message,
    }));
  } else if (err instanceof mongoose.Error.ValidationError) {
    statusCode = 400;
    message = "Validation failed";
    errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
  } else if (err instanceof mongoose.Error.CastError) {
    statusCode = 400;
    message = `Invalid ${err.path}`;
  } else if (err?.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyPattern ?? {})[0] ?? "field";
    message = `Duplicate value for ${field}`;
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (err?.type === "entity.parse.failed") {
    statusCode = 400;
    message = "Invalid JSON body";
  }

  if (statusCode >= 500) {
    console.error("[error]", err);
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(errors ? { errors } : {}),
    ...(process.env.NODE_ENV !== "production" && statusCode >= 500
      ? { stack: err?.stack }
      : {}),
  });
};
