import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Extra machine-readable fields merged into the JSON body (e.g. `problems`). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export class BadRequest extends HttpError {
  constructor(message = "Bad request") {
    super(400, message);
  }
}
export class Unauthorized extends HttpError {
  constructor(message = "Unauthorized") {
    super(401, message);
  }
}
export class Forbidden extends HttpError {
  constructor(message = "Forbidden") {
    super(403, message);
  }
}
export class NotFound extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}
export class Conflict extends HttpError {
  constructor(message = "Conflict") {
    super(409, message);
  }
}
/** The room already has its candidate (ADR 0012). Carries a code so clients don't match on message text. */
export class RoomFull extends HttpError {
  constructor() {
    super(409, "This interview already has a candidate", { conflict: "room_full" });
  }
}

export class UnprocessableEntity extends HttpError {
  constructor(message = "Unprocessable entity") {
    super(422, message);
  }
}
export class TooManyRequests extends HttpError {
  constructor(
    message = "Too many requests",
    public readonly retryAfterSeconds?: number,
  ) {
    super(429, message);
  }
}
export class PayloadTooLarge extends HttpError {
  constructor(message = "Payload too large") {
    super(413, message);
  }
}

/** Wrap async route handlers so rejected promises reach the error middleware (Express 4). */
export const asyncHandler =
  <R extends Request>(fn: (req: R, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: R, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", issues: err.issues });
    return;
  }
  if (err instanceof HttpError) {
    if (err instanceof TooManyRequests && err.retryAfterSeconds) {
      res.setHeader("Retry-After", String(err.retryAfterSeconds));
    }
    res.status(err.status).json({ ...err.details, error: err.message });
    return;
  }
  // A database trigger refused a locked change (ADR 0007, 0017) that slipped past the API's own checks
  // (e.g. a race): a conflict, not a server error.
  const pgCode = (err as { cause?: { code?: unknown }; code?: unknown })?.cause?.code ?? (err as { code?: unknown })?.code;
  if (pgCode === "23001") {
    res.status(409).json({ error: "That can't be changed any more.", conflict: "locked" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
