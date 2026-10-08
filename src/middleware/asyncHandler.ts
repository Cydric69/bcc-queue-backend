import type { NextFunction, Request, RequestHandler, Response } from "express";

// Wraps async route handlers so rejected promises reach the error handler
export const asyncHandler =
  (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
