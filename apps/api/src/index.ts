import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { executionQueue, redis } from "./queue.js";

const server = createServer(createApp());
// TODO (build step 4): attach the WebSocket gateway (Yjs sync + room events) to `server`.

server.listen(config.PORT, () => {
  console.log(`api listening on http://localhost:${config.PORT}`);
});

const shutdown = async () => {
  server.close();
  await executionQueue.close();
  await redis.quit();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
