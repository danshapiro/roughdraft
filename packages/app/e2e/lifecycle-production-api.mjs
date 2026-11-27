import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { createApp } from "../../server/dist/index.js";

// Each lifecycle test owns this process and state directory. Advancing only
// its monotonic clock exercises real deadline guards without a two-minute
// sleep; browser rendering and HTTP use the actual compiled application.
let clockOffset = 0;
const realPerformance = globalThis.performance;
Object.defineProperty(globalThis, "performance", {
  configurable: true,
  value: new Proxy(realPerformance, {
    get(target, key) {
      if (key === "now") return () => realPerformance.now() + clockOffset;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
});

const root = process.env.LIFECYCLE_ROOT;
if (!root) throw new Error("LIFECYCLE_ROOT is required");
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });
const { app, dispose } = createApp({
  port: Number(process.env.LIFECYCLE_PORT ?? 0),
  homeDir: home,
  comparisonsDir: path.join(root, "comparisons"),
  processStateDir: path.join(root, "process-state"),
  allowLocalFiles: true,
});
const network = {
  activeStreams: 0,
  maximumStreams: 0,
  streamRequests: 0,
  stateRequests: 0,
};
const server = createServer((request, response) => {
  const pathname = request.url?.split("?")[0];
  if (pathname === "/api/comparisons/events") {
    network.streamRequests++;
    network.activeStreams++;
    network.maximumStreams = Math.max(
      network.maximumStreams,
      network.activeStreams,
    );
    response.once("close", () => network.activeStreams--);
  } else if (
    request.method === "GET" &&
    /^\/api\/comparisons\/[^/]+\/state$/.test(pathname ?? "")
  )
    network.stateRequests++;
  app(request, response);
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  dispose();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("disconnect", stop);
process.on("message", (message) => {
  if (message.type === "network-stats") {
    process.send?.({ type: "network-stats", id: message.id, network });
    return;
  }
  if (message.type !== "advance-clock") return;
  clockOffset += message.milliseconds;
  process.send?.({ type: "clock-advanced", id: message.id });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(process.env.LIFECYCLE_PORT ?? 0), "127.0.0.1", resolve);
});
process.send?.({ type: "ready", port: server.address().port });
