import type { RequestHandler } from "express";
import type { ZodType } from "zod";

type Source = "body" | "query" | "params";

// Validates a request part against a Zod schema.
// - body: req.body is replaced with the parsed (trimmed/typed) data
// - query/params: parsed data is stored in res.locals.validated[source]
//   (req.query is read-only in Express 5, so it is never overwritten)
// Validation errors go to errorHandler, which formats the response.
export const validate =
  (schema: ZodType, source: Source = "body"): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      return next(result.error);
    }

    if (source === "body") {
      req.body = result.data;
    } else {
      res.locals.validated = {
        ...(res.locals.validated ?? {}),
        [source]: result.data,
      };
    }

    next();
  };
