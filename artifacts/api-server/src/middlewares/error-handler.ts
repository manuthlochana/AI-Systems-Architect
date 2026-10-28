import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger";

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const statusCode =
    typeof err?.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 500;

  const errorLog = req.log ?? logger;
  errorLog.error(
    {
      err: {
        message: err?.message,
        stack: err?.stack,
        code: err?.code,
        name: err?.name,
      },
      method: req.method,
      url: req.originalUrl || req.url,
      statusCode,
    },
    "Unhandled Express server error",
  );

  const message =
    statusCode >= 500
      ? "An unexpected internal server error occurred."
      : (err?.message || "Invalid request.");

  res.status(statusCode).json({
    error: message,
    statusCode,
  });
};
