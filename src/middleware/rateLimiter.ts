import rateLimit from "express-rate-limit";

const base = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
};

// General limiter for the whole API
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

// Stricter limiter for ticket creation (spam protection).
// Many students share one campus Wi-Fi IP, so keep this generous.
export const createTicketLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  limit: 40,
  message: {
    success: false,
    message: "Too many ticket requests. Please wait a few minutes.",
  },
});
