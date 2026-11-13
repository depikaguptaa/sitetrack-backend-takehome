import { createApp } from "./app.js";
import { closePool } from "./db.js";

const port = Number(process.env.PORT ?? 3000);
const server = createApp().listen(port, () =>
  console.info(`SiteTrack API listening on ${port}`),
);

async function shutdown(signal: string) {
  console.info(`received ${signal}, shutting down`);
  server.close(async () => {
    await closePool();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
