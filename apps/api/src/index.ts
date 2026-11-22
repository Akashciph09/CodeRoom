import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db.js";
import { executionQueue, redis } from "./queue.js";
import { attachRealtimeGateway } from "./realtime/gateway.js";

const server = createServer(createApp());
const gateway = attachRealtimeGateway(server);

server.listen(config.PORT, () => {
  console.log(`api listening on http://localhost:${config.PORT} (instance ${gateway.instanceId.slice(0, 8)})`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await gateway.close(); // persists open editor documents
  await executionQueue.close();
  await redis.quit();
  await closeDb();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
