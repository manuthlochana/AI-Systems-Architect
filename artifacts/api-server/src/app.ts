import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(
  "/api/webhook/whatsapp",
  express.raw({ type: "application/json", limit: "1mb" }),
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Serve the built admin dashboard from the same origin as the API, so the
// frontend's relative /api/... calls always reach this server.
const staticDir =
  process.env.STATIC_DIR ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../media-class-assistant/dist/public",
  );
if (fs.existsSync(path.join(staticDir, "index.html"))) {
  app.use(express.static(staticDir));
  // Client-side routing fallback for non-API GET requests.
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

export default app;
