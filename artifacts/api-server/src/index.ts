import app from "./app";
import { logger } from "./lib/logger";
import { flushAllDebouncedReplies, startWebhookWorker } from "./lib/webhook-worker";

process.on("unhandledRejection", (reason) => {
  logger.error(
    { err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason },
    "Unhandled promise rejection caught",
  );
});

process.on("uncaughtException", (error) => {
  logger.fatal(
    { err: { message: error.message, stack: error.stack } },
    "Uncaught exception caught",
  );
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startWebhookWorker();
});

const handleShutdown = async (signal: string) => {
  logger.info({ signal }, "Graceful shutdown initiated: flushing debounced replies and stopping server");
  try {
    await flushAllDebouncedReplies();
  } catch (err) {
    logger.error({ err }, "Error flushing debounced replies during shutdown");
  } finally {
    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(0);
    }, 10_000).unref();
  }
};

process.on("SIGTERM", () => void handleShutdown("SIGTERM"));
process.on("SIGINT", () => void handleShutdown("SIGINT"));
