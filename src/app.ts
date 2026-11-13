import express from "express";
import { resolve } from "node:path";
import { query } from "./db.js";
import { asyncRoute } from "./http.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter, notificationsRouter } from "./routes/projects.js";
import { tasksRouter } from "./routes/tasks.js";
import {
  companyDeliveriesRouter,
  companyStoreRouter,
  deliveriesActionRouter,
  materialsRouter,
  projectDeliveriesRouter,
  projectStoreRouter,
} from "./routes/inventory.js";
import { errorHandler } from "./http.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb", strict: true }));
  app.get(
    "/health",
    asyncRoute(async (_req, res) => {
      await query("SELECT 1");
      res.json({ status: "ok", database: "ok" });
    }),
  );
  app.get("/docs", (_req, res) => res.json({ openapi: "/openapi.yaml" }));
  app.get("/openapi.yaml", (_req, res) =>
    res
      .type("text/yaml")
      .sendFile(resolve(process.cwd(), "docs", "openapi.yaml")),
  );
  app.use("/auth", authRouter);
  app.use("/notifications", notificationsRouter);
  app.use("/materials", materialsRouter);
  app.use("/company-store", companyStoreRouter);
  app.use("/company-store/deliveries", companyDeliveriesRouter);
  app.use("/deliveries", deliveriesActionRouter);
  app.use("/projects/:projectId/tasks", tasksRouter);
  app.use("/projects/:projectId/store", projectStoreRouter);
  app.use("/projects/:projectId/deliveries", projectDeliveriesRouter);
  app.use("/projects", projectsRouter);
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: { code: "not_found", message: "Endpoint not found" } }),
  );
  app.use(errorHandler);
  return app;
}
