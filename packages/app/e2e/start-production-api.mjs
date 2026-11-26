import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../server/dist/index.js";

// The same compiled server serves the built frontend and API. No Vite process,
// second store owner or source transpiler participates in this qualification.
const temporary = fileURLToPath(
  new URL("../../../.test-tmp/", import.meta.url),
);
fs.mkdirSync(temporary, { recursive: true });
for (const entry of fs.readdirSync(temporary)) {
  const owner = /^playwright-production-(\d+)-/.exec(entry);
  if (!owner) continue;
  try {
    process.kill(Number(owner[1]), 0);
  } catch (error) {
    if (error.code === "ESRCH")
      fs.rmSync(path.join(temporary, entry), { recursive: true, force: true });
  }
}
const root = fs.mkdtempSync(
  path.join(temporary, `playwright-production-${process.pid}-`),
);
const home = path.join(root, "home");
fs.mkdirSync(home);
const port = Number(process.env.API_PORT ?? 4317);
const { app, dispose } = createApp({
  port,
  homeDir: home,
  comparisonsDir: path.join(root, "comparisons"),
  processStateDir: path.join(root, "process-state"),
  allowLocalFiles: true,
});
const server = createHttpServer(app);
let stopping = false;
const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
const stop = () => {
  if (stopping) return;
  stopping = true;
  dispose();
  server.closeAllConnections();
  server.close(() => {
    cleanup();
    process.exit(0);
  });
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.once("exit", cleanup);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
