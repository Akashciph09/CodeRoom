import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
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
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
};
