import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import type { CopyRequest, ReconcileRequest } from "@roughdraft/rfm";
import type { ComparisonReviewData } from "../src/comparison-types";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  selectRichText,
  writeProjectFile,
} from "./helpers";

const initial =
  "# Live update lifecycle\n\nThe planting schedule is ready.\n\nThe lighting schedule is ready.\n\nThe final notes are pending.\n";
const headers = { Connection: "close" };
interface NetworkStats {
  activeStreams: number;
  maximumStreams: number;
  streamRequests: number;
  stateRequests: number;
}

class OwnedServer {
  child: ChildProcess | undefined;
  port = 0;
  constructor(
    readonly root: string,
    readonly log: string,
  ) {}
  get origin() {
    return `http://127.0.0.1:${this.port}`;
  }
  async start() {
    const child = fork(
      fileURLToPath(new URL("./lifecycle-production-api.mjs", import.meta.url)),
      [],
      {
        env: {
          ...process.env,
          LIFECYCLE_ROOT: this.root,
          LIFECYCLE_PORT: String(this.port),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    this.child = child;
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => fs.appendFileSync(this.log, chunk));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The owned lifecycle server did not start")),
        7_500,
      );
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`The owned lifecycle server exited with ${code}`));
      });
      child.once("message", (message: { type: string; port: number }) => {
        clearTimeout(timer);
        if (message.type !== "ready")
          reject(new Error("Unexpected lifecycle server startup message"));
        this.port = message.port;
        resolve();
      });
    });
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited.finally(() => clearTimeout(timer));
  }
  async restart() {
    await this.stop();
    await this.start();
  }
  async advanceClock(milliseconds: number) {
    const child = this.child;
    if (!child) throw new Error("The owned lifecycle server is stopped");
    const id = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The lifecycle server clock did not advance")),
        7_500,
      );
      child.once("message", (message: { type: string; id: string }) => {
        clearTimeout(timer);
        if (message.type !== "clock-advanced" || message.id !== id)
          reject(new Error("Unexpected clock advancement acknowledgment"));
        resolve();
      });
      child.send({ type: "advance-clock", milliseconds, id });
    });
  }
  async networkStats(): Promise<NetworkStats> {
    const child = this.child;
    if (!child) throw new Error("The owned lifecycle server is stopped");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The lifecycle network stats did not arrive")),
        7_500,
      );
      child.once(
        "message",
        (message: { type: string; id: string; network: NetworkStats }) => {
          clearTimeout(timer);
          if (message.type !== "network-stats" || message.id !== id)
            reject(new Error("Unexpected network stats acknowledgment"));
          else resolve(message.network);
        },
      );
      child.send({ type: "network-stats", id });
    });
  }
}

interface Lifecycle {
  project: string;
  server: OwnedServer;
  target: string;
  id: string;
  api: string;
  read(id?: string): Promise<ComparisonReviewData>;
}

const test = base.extend<{ lifecycle: Lifecycle }>({
  lifecycle: async ({ page, request }, use, info) => {
    const project = createMarkdownProject("live-lifecycle");
    const server = new OwnedServer(
      path.join(project, "server-state"),
      info.outputPath("owned-server.log"),
    );
    try {
      await server.start();
      const target = writeProjectFile(project, "practice.md", initial);
      const api = `${server.origin}/api/comparisons`;
      const response = await request.post(`${api}/document`, {
        headers,
        data: {
          targetPath: target,
          autosave: target,
          handoff: "chat",
          title: "Review a release plan while another editor updates it",
        },
      });
      await expect(response).toBeOK();
      const { id } = await response.json();
      await page.goto(`${server.origin}/?comparison=${id}`);
      await expect(richTextEditor(page)).toBeVisible();
      await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        /^(Review saved|Saved to file)$/,
      );
      await use({
        project,
        server,
        target,
        id,
        api,
        read: async (reviewId = id) =>
          (await request.get(`${api}/${reviewId}`, { headers })).json(),
      });
    } finally {
      await server.stop();
      removeMarkdownProject(project);
    }
  },
});

function gate() {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

async function conflict(page: Page, lifecycle: Lifecycle) {
  const held = gate();
  let captured = false;
  await page.route(
    `**/api/comparisons/${lifecycle.id}/reconcile`,
    async (route) => {
      if (
        !captured &&
        route
          .request()
          .postDataJSON()
          .draft.markdown.includes("orchard schedule")
      ) {
        captured = true;
        await held.waiting;
      }
      await route.continue();
    },
  );
  try {
    await selectRichText(page, "planting schedule");
    await page.keyboard.insertText("orchard schedule");
    await expect.poll(() => captured).toBe(true);
    fs.writeFileSync(
      lifecycle.target,
      initial.replace("planting schedule", "garden schedule"),
    );
  } finally {
    held.release();
  }
  await expect(page.getByTestId("revision-discard")).toBeVisible();
}

async function openCopy(page: Page, destination: string) {
  await page.getByTestId("revision-save-separately").click();
  await page.getByTestId("revision-copy-path").fill(destination);
  await expect(page.getByTestId("revision-save-copy-confirm")).toBeEnabled();
}

test("eight tabs resume one shared stream after a server restart and leave temporary polling", async ({
  page,
  context,
  lifecycle,
}, testInfo) => {
  test.setTimeout(45_000);
  const tabs = [page];
  const states: Array<{ phase: string; network: NetworkStats }> = [];
  try {
    const extra = await Promise.all(
      Array.from({ length: 7 }, () => context.newPage()),
    );
    tabs.push(...extra);
    await Promise.all(
      extra.map(async (tab) => {
        await tab.goto(
          `${lifecycle.server.origin}/?comparison=${lifecycle.id}`,
        );
        await expect(richTextEditor(tab)).toBeVisible();
      }),
    );
    await expect
      .poll(async () => (await lifecycle.server.networkStats()).activeStreams)
      .toBe(1);
    const before = await lifecycle.server.networkStats();
    expect(before.maximumStreams).toBe(1);
    states.push({ phase: "before restart", network: before });

    await lifecycle.server.restart();
    await expect
      .poll(async () => (await lifecycle.server.networkStats()).activeStreams)
      .toBe(1);
    // A window longer than the one-second fallback interval distinguishes
    // resumed streaming from permanent short-request polling.
    await expect(async () => {
      const beginning = await lifecycle.server.networkStats();
      await new Promise((resolve) => setTimeout(resolve, 1250));
      const end = await lifecycle.server.networkStats();
      expect(end.stateRequests).toBe(beginning.stateRequests);
      expect(end.activeStreams).toBe(1);
      expect(end.maximumStreams).toBe(1);
    }).toPass({ timeout: 10_000, intervals: [100] });
    states.push({
      phase: "stream recovered without polling",
      network: await lifecycle.server.networkStats(),
    });

    const changed = initial.replace(
      "The lighting schedule is ready.",
      "The lighting schedule changed after stream recovery.",
    );
    fs.writeFileSync(lifecycle.target, changed);
    await Promise.all(
      tabs.map(async (tab) => {
        await expect(richTextEditor(tab)).toContainText(
          "The lighting schedule changed after stream recovery.",
        );
        await expect(tab.getByTestId("revision-conflict")).toHaveCount(0);
      }),
    );
    expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(changed);
    const final = await lifecycle.server.networkStats();
    expect(final.activeStreams).toBe(1);
    expect(final.maximumStreams).toBe(1);
    states.push({
      phase: "outside edit reached all eight tabs",
      network: final,
    });
  } finally {
    fs.writeFileSync(
      testInfo.outputPath("shared-stream-restart.json"),
      JSON.stringify(states, null, 2),
    );
    await Promise.all(tabs.slice(1).map((tab) => tab.close()));
  }
});

for (const interruption of [
  "expired offline request",
  "server restart",
] as const) {
  test(`a never-received save resumes automatically after ${interruption} and a reload; the late request is fenced`, async ({
    page,
    context,
    request,
    lifecycle,
  }) => {
    const held = gate();
    let originalRequest: ReconcileRequest | undefined;
    await page.route(
      `**/api/comparisons/${lifecycle.id}/reconcile`,
      async (route) => {
        const body = route.request().postDataJSON();
        if (
          !originalRequest &&
          body.draft.markdown.includes("orchard schedule")
        ) {
          originalRequest = body;
          await held.waiting;
          await route.abort("failed").catch(() => {});
        } else await route.continue();
      },
    );
    try {
      await selectRichText(page, "planting schedule");
      await page.keyboard.insertText("orchard schedule");
      await expect.poll(() => Boolean(originalRequest)).toBe(true);
      await context.setOffline(true);
      if (interruption === "server restart") await lifecycle.server.restart();
      else await lifecycle.server.advanceClock(240_000);
      expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(initial);
      await context.setOffline(false);
      await page.reload();
      held.release();
      await expect
        .poll(() => fs.readFileSync(lifecycle.target, "utf8"))
        .toContain("orchard schedule");
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      await expect(page.getByTestId("revision-error")).toHaveCount(0);
      const settled = await lifecycle.read();
      const late = await request.post(
        `${lifecycle.api}/${lifecycle.id}/reconcile`,
        {
          headers,
          data: originalRequest,
        },
      );
      expect((await late.json()).status).toMatch(
        /not-received|operation-expired|rejected/,
      );
      expect((await lifecycle.read()).draft).toEqual(settled.draft);
      expect(
        fs.readFileSync(lifecycle.target, "utf8").match(/orchard schedule/g),
      ).toHaveLength(1);
    } finally {
      held.release();
      await context.setOffline(false);
    }
  });
}

for (const interruption of [
  "expired offline request",
  "server restart",
] as const) {
  test(`a never-received copy after ${interruption} preserves its chosen path for one safe retry and fences the late copy`, async ({
    page,
    context,
    request,
    lifecycle,
  }) => {
    await conflict(page, lifecycle);
    const originalFile = fs.readFileSync(lifecycle.target, "utf8");
    const destination = path.join(
      lifecycle.project,
      "my-chosen-recovery-copy.md",
    );
    const held = gate();
    let originalRequest: CopyRequest | undefined;
    let copyRequests = 0;
    await page.route(
      `**/api/comparisons/${lifecycle.id}/copy`,
      async (route) => {
        copyRequests++;
        if (!originalRequest) {
          originalRequest = route.request().postDataJSON();
          await held.waiting;
          await route.abort("failed").catch(() => {});
        } else await route.continue();
      },
    );
    try {
      await openCopy(page, destination);
      await page.getByTestId("revision-save-copy-confirm").click();
      await expect.poll(() => Boolean(originalRequest)).toBe(true);
      await context.setOffline(true);
      if (interruption === "server restart") await lifecycle.server.restart();
      else await lifecycle.server.advanceClock(240_000);
      expect(fs.existsSync(destination)).toBe(false);
      await context.setOffline(false);
      await page.reload();
      held.release();
      await expect(page.getByTestId("revision-save-separately")).toBeVisible();
      await page.getByTestId("revision-save-separately").click();
      await expect(page.getByTestId("revision-copy-path")).toHaveValue(
        destination,
      );
      await expect(
        page.getByTestId("revision-save-copy-confirm"),
      ).toBeEnabled();
      await page.getByTestId("revision-save-copy-confirm").click();
      await expect(page.getByTestId("revision-copy-saved-path")).toHaveText(
        destination,
      );
      expect(copyRequests).toBe(2);
      const late = await request.post(`${lifecycle.api}/${lifecycle.id}/copy`, {
        headers,
        data: originalRequest,
      });
      expect((await late.json()).status).toMatch(
        /not-received|operation-expired|rejected/,
      );
      expect(fs.readFileSync(destination, "utf8")).toContain(
        "orchard schedule",
      );
      expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(originalFile);
      expect(
        fs
          .readdirSync(lifecycle.project)
          .filter((file) => file.endsWith(".md"))
          .sort(),
      ).toEqual(["my-chosen-recovery-copy.md", "practice.md"]);
    } finally {
      held.release();
      await context.setOffline(false);
    }
  });
}

test("a save committed before restart but never acknowledged preserves newer offline typing after reload", async ({
  page,
  context,
  lifecycle,
}) => {
  const allowCommit = gate();
  const releaseAcknowledgment = gate();
  let captured = false;
  let committed = false;
  await page.route(
    `**/api/comparisons/${lifecycle.id}/reconcile`,
    async (route) => {
      if (
        !captured &&
        route
          .request()
          .postDataJSON()
          .draft.markdown.includes("orchard schedule")
      ) {
        captured = true;
        await allowCommit.waiting;
        const response = await route.fetch();
        expect((await response.json()).status).toBe("committed");
        committed = true;
        await releaseAcknowledgment.waiting;
        await route.abort("failed").catch(() => {});
      } else await route.continue();
    },
  );
  try {
    await selectRichText(page, "planting schedule");
    await page.keyboard.insertText("orchard schedule");
    await expect.poll(() => captured).toBe(true);
    await context.setOffline(true);
    await selectRichText(page, "orchard schedule");
    await page.keyboard.insertText("orchard schedule continued");
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.entries(sessionStorage).some(([key, value]) => {
            if (!key.startsWith("roughdraft-draft:")) return false;
            return JSON.parse(value).draft.markdown.includes(
              "orchard schedule continued",
            );
          }),
        ),
      )
      .toBe(true);
    allowCommit.release();
    await expect.poll(() => committed).toBe(true);
    expect(fs.readFileSync(lifecycle.target, "utf8")).toContain(
      "orchard schedule",
    );
    expect(fs.readFileSync(lifecycle.target, "utf8")).not.toContain(
      "orchard schedule continued",
    );
    await lifecycle.server.restart();
    await context.setOffline(false);
    await page.reload();
    releaseAcknowledgment.release();
    await expect
      .poll(() => fs.readFileSync(lifecycle.target, "utf8"))
      .toContain("orchard schedule continued");
    await expect(richTextEditor(page)).toContainText(
      "orchard schedule continued",
    );
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    expect(
      fs.readFileSync(lifecycle.target, "utf8").match(/orchard schedule/g),
    ).toHaveLength(1);
  } finally {
    allowCommit.release();
    releaseAcknowledgment.release();
    await context.setOffline(false);
  }
});

test("a committed separate copy survives a lost response and process restart without creating a second copy", async ({
  page,
  request,
  lifecycle,
}) => {
  await conflict(page, lifecycle);
  const destination = path.join(lifecycle.project, "chosen-recovery-copy.md");
  const originalFile = fs.readFileSync(lifecycle.target, "utf8");
  let copies = 0;
  let copiedId = "";
  await page.route(`**/api/comparisons/${lifecycle.id}/copy`, async (route) => {
    copies++;
    const response = await route.fetch();
    const result = await response.json();
    expect(result.status).toBe("committed");
    copiedId = result.state.review.id;
    await route.abort("failed");
  });
  await openCopy(page, destination);
  await page.getByTestId("revision-save-copy-confirm").click();
  const dialog = page.getByTestId("revision-save-copy-dialog");
  await expect(dialog).toContainText("Save status unknown");
  await expect.poll(() => copiedId).not.toBe("");
  await lifecycle.server.restart();
  await dialog
    .getByRole("button", { name: "Retry save status", exact: true })
    .click();
  await expect(page.getByTestId("revision-copy-saved-path")).toHaveText(
    destination,
  );
  expect(copies).toBe(1);
  expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(originalFile);
  expect(fs.readFileSync(destination, "utf8")).toContain("orchard schedule");
  const href = await dialog
    .getByRole("link", { name: "Open saved review" })
    .getAttribute("href");
  expect(
    new URL(href ?? "", lifecycle.server.origin).searchParams.get("comparison"),
  ).toBe(copiedId);
  await expect(
    await request.get(`${lifecycle.api}/${copiedId}`, { headers }),
  ).toBeOK();
  expect(
    fs
      .readdirSync(lifecycle.project)
      .filter((file) => file.endsWith(".md"))
      .sort(),
  ).toEqual(["chosen-recovery-copy.md", "practice.md"]);
});

test("a copy status returned while its dialog is closed survives reload and reopens the saved path once", async ({
  page,
  lifecycle,
}) => {
  await conflict(page, lifecycle);
  const destination = path.join(lifecycle.project, "closed-dialog-copy.md");
  const originalFile = fs.readFileSync(lifecycle.target, "utf8");
  const held = gate();
  let copies = 0;
  let capturedStatus = false;
  await page.route("**/api/comparisons/operations/*/resolve", async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    if (result.status === "committed") {
      capturedStatus = true;
      await held.waiting;
    }
    await route.fulfill({ response }).catch(() => {});
  });
  await page.route(`**/api/comparisons/${lifecycle.id}/copy`, async (route) => {
    copies++;
    const response = await route.fetch();
    expect((await response.json()).status).toBe("committed");
    await route.abort("failed");
  });
  try {
    await openCopy(page, destination);
    await page.getByTestId("revision-save-copy-confirm").click();
    const dialog = page.getByTestId("revision-save-copy-dialog");
    await expect(dialog).toContainText("Save status unknown");
    await dialog
      .getByRole("button", { name: "Retry save status", exact: true })
      .click();
    await expect.poll(() => capturedStatus).toBe(true);
    await dialog.getByText("Close", { exact: true }).click();
    held.release();
    await expect
      .poll(() =>
        page.evaluate(
          (path) =>
            Object.entries(sessionStorage).some(
              ([key, value]) =>
                key.startsWith("roughdraft-draft:") &&
                JSON.parse(value).copyResult?.savedPath === path,
            ),
          destination,
        ),
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByTestId("revision-save-separately")).toBeVisible();
    await page.getByTestId("revision-save-separately").click();
    await expect(page.getByTestId("revision-copy-saved-path")).toHaveText(
      destination,
    );
    const savedDialog = page.getByTestId("revision-save-copy-dialog");
    await expect(
      savedDialog.getByRole("link", { name: "Open saved review" }),
    ).toBeVisible();
    await savedDialog.getByTestId("revision-copy-done").click();
    expect(copies).toBe(1);
    expect(fs.readFileSync(destination, "utf8")).toContain("orchard schedule");
    expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(originalFile);
    expect(
      fs
        .readdirSync(lifecycle.project)
        .filter((file) => file.endsWith(".md"))
        .sort(),
    ).toEqual(["closed-dialog-copy.md", "practice.md"]);
  } finally {
    held.release();
  }
});

test("a late successful copy keeps newer typing on the original review", async ({
  page,
  lifecycle,
}) => {
  await conflict(page, lifecycle);
  await page.clock.install();
  const held = gate();
  const destination = path.join(lifecycle.project, "captured-generation.md");
  let captured = false;
  await page.route(`**/api/comparisons/${lifecycle.id}/copy`, async (route) => {
    const response = await route.fetch();
    captured = true;
    await held.waiting;
    await route.fulfill({ response });
  });
  try {
    await openCopy(page, destination);
    await page.getByTestId("revision-save-copy-confirm").click();
    await expect.poll(() => captured).toBe(true);
    await page.clock.fastForward(10_001);
    const dialog = page.getByTestId("revision-save-copy-dialog");
    await expect(dialog).toContainText("Save status unknown");
    await dialog.getByText("Close", { exact: true }).click();
    await selectRichText(page, "final notes");
    await page.keyboard.insertText("fresh final notes");
    held.release();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Newer edits remain in this review" }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("comparison")).toBe(
      lifecycle.id,
    );
    await expect(richTextEditor(page)).toContainText("fresh final notes");
    expect(fs.readFileSync(destination, "utf8")).not.toContain(
      "fresh final notes",
    );
    expect(fs.readFileSync(lifecycle.target, "utf8")).toContain(
      "garden schedule",
    );
    await page.getByTestId("revision-save-separately").click();
    await expect(page.getByTestId("revision-copy-saved-path")).toHaveText(
      destination,
    );
    await page.getByTestId("revision-copy-done").click();
    await expect(richTextEditor(page)).toContainText("fresh final notes");
  } finally {
    held.release();
  }
});

for (const incomingChange of ["overlapping", "independent"] as const) {
  test(`a confirmation responds correctly to a second ${incomingChange} outside edit`, async ({
    page,
    lifecycle,
  }) => {
    await conflict(page, lifecycle);
    await page.getByTestId("revision-overwrite").click();
    const dialog = page.getByTestId("revision-resolve-dialog");
    await expect(dialog).toBeVisible();
    const changed = fs
      .readFileSync(lifecycle.target, "utf8")
      .replace(
        incomingChange === "overlapping"
          ? "garden schedule"
          : "lighting schedule",
        incomingChange === "overlapping"
          ? "meadow schedule"
          : "lantern schedule",
      );
    fs.writeFileSync(lifecycle.target, changed);
    if (incomingChange === "overlapping") {
      await expect(dialog).toContainText("The overlapping changes changed");
      await expect(page.getByTestId("revision-resolve-confirm")).toBeDisabled();
      expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(changed);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByTestId("revision-overwrite").click();
      await expect(dialog).toContainText("meadow");
    } else {
      await expect
        .poll(async () => {
          const response = await page.request.get(
            `${lifecycle.api}/${lifecycle.id}/state`,
            { headers },
          );
          return (await response.json()).disk.text;
        })
        .toContain("lantern schedule");
      await expect(page.getByTestId("revision-resolve-confirm")).toBeEnabled();
    }
    await page.getByTestId("revision-resolve-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
    await expect
      .poll(() => fs.readFileSync(lifecycle.target, "utf8"))
      .toContain("orchard schedule");
    if (incomingChange === "independent")
      expect(fs.readFileSync(lifecycle.target, "utf8")).toContain(
        "lantern schedule",
      );
  });
}

test("a failed recovery write blocks destructive conflict resolution until recovery succeeds", async ({
  page,
  lifecycle,
}) => {
  await page.route(`**/api/comparisons/${lifecycle.id}/checkpoint`, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Practice recovery storage unavailable" }),
    }),
  );
  await conflict(page, lifecycle);
  const unchanged = fs.readFileSync(lifecycle.target, "utf8");
  await expect(page.getByTestId("revision-conflict")).toContainText(
    "Recovery has not synced yet",
  );
  await page.getByTestId("revision-overwrite").click();
  await page.getByTestId("revision-resolve-confirm").click();
  const dialog = page.getByTestId("revision-resolve-dialog");
  await expect(dialog).toContainText(
    "Recovery must finish before replacing overlapping changes",
  );
  expect(fs.readFileSync(lifecycle.target, "utf8")).toBe(unchanged);
  await expect(richTextEditor(page)).toContainText("orchard schedule");
  await page.unroute(`**/api/comparisons/${lifecycle.id}/checkpoint`);
  await page.getByTestId("revision-resolve-confirm").click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => fs.readFileSync(lifecycle.target, "utf8"))
    .toContain("orchard schedule");
});

for (const peerConnection of ["live", "reconnected"] as const) {
  test(`a ${peerConnection} losing tab receives a recovery notice after another tab explicitly overwrites its saved edit`, async ({
    page,
    browser,
    lifecycle,
  }) => {
    const peerContext = await browser.newContext();
    const peer = await peerContext.newPage();
    const held = gate();
    let captured = false;
    await page.route(
      `**/api/comparisons/${lifecycle.id}/reconcile`,
      async (route) => {
        if (
          !captured &&
          route
            .request()
            .postDataJSON()
            .draft.markdown.includes("orchard schedule")
        ) {
          captured = true;
          await held.waiting;
        }
        await route.continue();
      },
    );
    try {
      await peer.goto(`${lifecycle.server.origin}/?comparison=${lifecycle.id}`);
      await expect(richTextEditor(peer)).toBeVisible();
      await selectRichText(page, "planting schedule");
      await page.keyboard.insertText("orchard schedule");
      await expect.poll(() => captured).toBe(true);
      await selectRichText(peer, "planting schedule");
      await peer.keyboard.insertText("garden schedule");
      await expect
        .poll(() => fs.readFileSync(lifecycle.target, "utf8"))
        .toContain("garden schedule");
      await expect(peer.getByTestId("revision-file-status")).toHaveAttribute(
        "aria-label",
        /^(Review saved|Saved to file)$/,
      );
      if (peerConnection === "reconnected") await peerContext.setOffline(true);
      held.release();
      await expect(page.getByTestId("revision-overwrite")).toBeVisible();
      await page.getByTestId("revision-overwrite").click();
      await page.getByTestId("revision-resolve-confirm").click();
      await expect(page.getByTestId("revision-conflict")).toHaveCount(0);
      if (peerConnection === "reconnected") await peerContext.setOffline(false);
      await expect(richTextEditor(peer)).toContainText("orchard schedule");
      const notice = peer
        .getByRole("status")
        .filter({ hasText: /overwrit|replac/i });
      await expect(notice).toBeVisible();
      await expect(
        notice.getByRole("button", { name: "Recovery copies", exact: true }),
      ).toBeVisible();
      await expect(peer.getByTestId("revision-conflict")).toHaveCount(0);
    } finally {
      held.release();
      await peerContext.close();
    }
  });
}
