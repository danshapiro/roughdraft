import { defineConfig, devices } from "@playwright/test";

const appPort = Number(process.env.PLAYWRIGHT_APP_PORT ?? 4318);
const apiPort = Number(process.env.API_PORT ?? 4317);
const appUrl = `http://127.0.0.1:${appPort}`;
const production = process.env.PLAYWRIGHT_PRODUCTION === "1";
const apiUrl = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 7_500,
  },
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: production ? apiUrl : appUrl,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: production
    ? [
        {
          command: `API_PORT=${apiPort} node e2e/start-production-api.mjs`,
          url: `${apiUrl}/api/status`,
          reuseExistingServer: false,
          gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
          stdout: "pipe",
          stderr: "pipe",
        },
      ]
    : [
        {
          command: `API_PORT=${apiPort} pnpm exec tsx e2e/start-api.ts`,
          port: apiPort,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: `API_PORT=${apiPort} pnpm dev --host 127.0.0.1 --port ${appPort}`,
          url: appUrl,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
});
