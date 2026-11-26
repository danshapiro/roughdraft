import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type APIRequestContext,
  expect,
  type Page,
  type TestInfo,
  test,
  type Worker,
} from "@playwright/test";
import {
  extractRoughdraftReviewIndex,
  type ReconcileRequest,
  type SyncComment,
  type SyncResult,
} from "@roughdraft/rfm";
import {
  createMarkdownProject,
  removeMarkdownProject,
  richTextEditor,
  writeProjectFile,
} from "./helpers";

const api = `http://127.0.0.1:${process.env.API_PORT ?? 4317}/api/comparisons`;
const fixtures = fileURLToPath(
  new URL("../../../docs/spec/fixtures/", import.meta.url),
);
const headers = { Connection: "close" };
const owner = (page: Page, name: string) =>
  richTextEditor(page)
    .getByRole("paragraph")
    .filter({ hasText: `Live owner ${name}:` });

function reviewFixture(paddingParagraphs = 750) {
  const source = fs.readFileSync(
    path.join(fixtures, "editing-review.md"),
    "utf8",
  );
  const endmatter = source.lastIndexOf("\n---\n");
  if (endmatter < 0)
    throw new Error(
      "The maintained editing fixture has no final review registry.",
    );
  const padding = Array.from(
    { length: paddingParagraphs },
    (_, index) =>
      `Unchanged section ${index + 1}. This paragraph provides real reading distance while the two pages keep their independent edits and feedback.`,
  ).join("\n\n");
  return `${source.slice(0, endmatter)}\n\n${padding}\n\nLive owner A: unchanged.\n\nLive owner B: unchanged.\n${source.slice(endmatter)}`;
}
function writeFixture(project: string, source: string) {
  const targetPath = writeProjectFile(project, "review.md", source);
  fs.cpSync(
    path.join(fixtures, "editing-review-assets"),
    path.join(project, "editing-review-assets"),
    { recursive: true },
  );
  fs.copyFileSync(
    path.join(fixtures, "editing-review-linked.md"),
    path.join(project, "editing-review-linked.md"),
  );
  return targetPath;
}
async function openReview(request: APIRequestContext, targetPath: string) {
  const created = await request.post(`${api}/document`, {
    headers,
    data: {
      targetPath,
      autosave: targetPath,
      handoff: "chat",
      title: "Review a long release plan across two pages",
    },
  });
  await expect(created).toBeOK();
  return (await created.json()).id as string;
}
async function ready(page: Page) {
  await expect(richTextEditor(page)).toBeVisible();
  await expect(page.getByTestId("revision-file-status")).toHaveAttribute(
    "aria-label",
    /^(Review saved|Saved to file)$/,
  );
}
async function append(page: Page, name: string, value: string) {
  await owner(page, name).click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(value);
}
function originalComments(source: string) {
  const comments = extractRoughdraftReviewIndex(source)
    .items.filter((item) => item.kind !== "suggestion")
    .map((item) => ({
      id: item.id,
      content: item.text,
      parentCommentId: item.parentId,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  expect(comments).toHaveLength(14);
  return comments;
}
function savedComments(comments: SyncComment[]) {
  return comments
    .map((item) => ({
      id: item.id,
      content: item.content,
      parentCommentId: item.parentCommentId ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
async function expectOriginalComments(
  request: APIRequestContext,
  id: string,
  source: string,
) {
  await expect
    .poll(async () => {
      const review = await (
        await request.get(`${api}/${id}`, { headers })
      ).json();
      return savedComments(review.reviewComments ?? []);
    })
    .toEqual(originalComments(source));
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function awaitSignal(
  signal: Promise<void>,
  label: string,
  timeout = 7500,
) {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeout,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}
function installMeasurements() {
  type ProfileEntry = { stage: string; at: number; duration: number };
  const scope = window as Window & {
    liveInputDelays: number[];
    liveInputEvents: { at: number; data: string | null }[];
    liveLongTasks: { at: number; duration: number }[];
    liveMergeEvents: {
      at: number;
      direction: string;
      status?: string;
      reason?: string;
      timing?: { startedAt: number; durationMs: number };
    }[];
    liveMergeMetrics: { workers: number; jobs: number; replies: number };
    liveApiEvents: Record<string, unknown>[];
    liveProfileOverflow: ProfileEntry[];
    roughdraftProfile: {
      entries: ProfileEntry[];
    };
  };
  scope.liveInputDelays = [];
  scope.liveInputEvents = [];
  scope.liveLongTasks = [];
  scope.liveMergeEvents = [];
  scope.liveApiEvents = [];
  scope.liveMergeMetrics = { workers: 0, jobs: 0, replies: 0 };
  scope.roughdraftProfile = { entries: [] };
  scope.liveProfileOverflow = [];
  // Preserve early timings when the app trims its ordinary 256-entry buffer.
  // This remains test-only, bounded, and does not change product diagnostics.
  const entries = scope.roughdraftProfile.entries;
  const splice = entries.splice.bind(entries);
  Object.defineProperty(entries, "splice", {
    value: (start: number, deleteCount?: number, ...items: ProfileEntry[]) => {
      const removed =
        deleteCount === undefined
          ? splice(start)
          : splice(start, deleteCount, ...items);
      const room = 4096 - scope.liveProfileOverflow.length;
      if (room > 0) scope.liveProfileOverflow.push(...removed.slice(0, room));
      return removed;
    },
  });
  const nativeFetch = window.fetch.bind(window);
  let apiSequence = 0;
  window.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!url.includes("/api/comparisons/")) return nativeFetch(input, init);
    const id = ++apiSequence;
    const record = (stage: string, detail: Record<string, unknown> = {}) => {
      if (scope.liveApiEvents.length < 1024)
        scope.liveApiEvents.push({ at: Date.now(), id, stage, url, ...detail });
    };
    record("fetch-start");
    const response = await nativeFetch(input, init);
    record("fetch-headers", { httpStatus: response.status });
    const nativeJson = response.json.bind(response);
    response.json = async () => {
      record("json-start");
      const value = await nativeJson();
      record("json-finished", {
        status: value?.status,
        revision: value?.state?.revision ?? value?.revision,
        reservationExpiresAt: value?.reservation?.expiresAt,
        lastOperationId:
          value?.state?.review?.lastOperation?.id ??
          value?.review?.lastOperation?.id,
      });
      return value;
    };
    return response;
  };
  document.addEventListener("beforeinput", (event) => {
    const at = performance.now();
    if (scope.liveInputEvents.length < 200)
      scope.liveInputEvents.push({
        at: Date.now(),
        data: (event as InputEvent).data,
      });
    requestAnimationFrame(() =>
      scope.liveInputDelays.push(performance.now() - at),
    );
  });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (scope.liveLongTasks.length < 512)
        scope.liveLongTasks.push({
          at: performance.timeOrigin + entry.startTime,
          duration: entry.duration,
        });
  }).observe({ entryTypes: ["longtask"] });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    private merges = false;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener("message", (event: MessageEvent) => {
        if (this.merges) {
          scope.liveMergeMetrics.replies++;
          const reply = event.data as {
            result?: { status?: string; reason?: string };
            timing?: { startedAt: number; durationMs: number };
          };
          if (scope.liveMergeEvents.length < 256)
            scope.liveMergeEvents.push({
              at: Date.now(),
              direction: "reply",
              status: reply.result?.status,
              reason: reply.result?.reason,
              timing: reply.timing,
            });
        }
      });
    }
    postMessage(
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (
        message &&
        typeof message === "object" &&
        "base" in message &&
        "local" in message &&
        "incoming" in message
      ) {
        if (!this.merges) {
          this.merges = true;
          scope.liveMergeMetrics.workers++;
        }
        scope.liveMergeMetrics.jobs++;
        if (scope.liveMergeEvents.length < 256)
          scope.liveMergeEvents.push({ at: Date.now(), direction: "job" });
      }
      if (Array.isArray(options)) super.postMessage(message, options);
      else super.postMessage(message, options);
    }
  };
}
function recordReconcileTraffic(page: Page, name: string, testInfo: TestInfo) {
  const target = testInfo.outputPath("reconcile-wire.jsonl");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let records = 0;
  const record = (direction: string, body: unknown) => {
    if (records++ >= 48) return;
    fs.appendFileSync(
      target,
      `${JSON.stringify({ page: name, at: Date.now(), direction, body })}\n`,
    );
  };
  const requestListener = (request: import("@playwright/test").Request) => {
    if (!request.url().endsWith("/reconcile")) return;
    record("request", request.postDataJSON());
  };
  const responseListener = async (
    response: import("@playwright/test").Response,
  ) => {
    if (!response.url().endsWith("/reconcile")) return;
    try {
      record("response", await response.json());
    } catch {
      // Reloads deliberately cancel held responses in the recovery scenario.
    }
  };
  page.on("request", requestListener);
  page.on("response", responseListener);
  return () => {
    page.off("request", requestListener);
    page.off("response", responseListener);
  };
}
async function failureSnapshot(
  testInfo: TestInfo,
  targetPath: string,
  id?: string,
) {
  if (fs.existsSync(targetPath)) {
    const savedPath = testInfo.outputPath("working-file-at-failure.md");
    fs.copyFileSync(targetPath, savedPath);
    await testInfo.attach("working-file-at-failure.md", {
      path: savedPath,
      contentType: "text/markdown",
    });
  }
  if (!id) return;
  try {
    const response = await fetch(`${api}/${id}`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) {
      const savedPath = testInfo.outputPath("saved-review-at-failure.json");
      fs.writeFileSync(savedPath, await response.text());
      await testInfo.attach("saved-review-at-failure.json", {
        path: savedPath,
        contentType: "application/json",
      });
    }
  } catch {
    /* Diagnostics must not mask the failing product assertion. */
  }
}
async function failureViews(
  testInfo: TestInfo,
  pages: Page[],
  filename = "ui-before-cleanup.json",
) {
  const views = await Promise.allSettled(
    pages.map((page) =>
      page.evaluate(() => ({
        status: document
          .querySelector('[data-testid="revision-file-status"]')
          ?.getAttribute("aria-label"),
        banner: document.querySelector('[data-testid="revision-conflict"]')
          ?.textContent,
        editorOwners: [
          ...document.querySelectorAll('[data-testid="rich-text-editor"] p'),
        ]
          .map((paragraph) => paragraph.textContent ?? "")
          .filter((text) => /^Live owner [AB]:/.test(text)),
        recovery: Object.fromEntries(
          Object.entries(localStorage).filter(([key]) =>
            /roughdraft|revision/i.test(key),
          ),
        ),
        measurements: Object.fromEntries(
          [
            "liveInputEvents",
            "liveInputDelays",
            "liveLongTasks",
            "liveMergeEvents",
            "liveMergeMetrics",
            "liveApiEvents",
            "roughdraftProfile",
            "liveProfileOverflow",
          ].map((key) => [key, Reflect.get(window, key)]),
        ),
      })),
    ),
  );
  fs.writeFileSync(
    testInfo.outputPath(filename),
    JSON.stringify(views, null, 2),
  );
}

test("both pages keep committing during continuous typing in the complex 100 KiB review", async ({
  page,
  browser,
  request,
}, testInfo) => {
  // Keep the two-second progress and input/frame limits strict while allowing
  // slow keyboard delivery and all integrity assertions to finish diagnosing.
  test.setTimeout(120_000);
  const project = createMarkdownProject("live-progress");
  const other = await browser.newContext();
  const second = await other.newPage();
  const gate = deferred();
  const firstCommits = deferred();
  const counts = { A: [] as number[], B: [] as number[] };
  const seen = { A: new Set<string>(), B: new Set<string>() };
  const responses: Array<{
    page: string;
    status: string;
    revision?: number;
    at: number;
    own: string;
  }> = [];
  const comparisonWorkers = new Set<Worker>();
  let fallbackCount = 0;
  let started = 0;
  let closing = false;
  const timeline: Record<string, unknown>[] = [];
  const recordTime = (entry: Record<string, unknown>) => {
    if (timeline.length >= 1024) return;
    const value = {
      at: Date.now(),
      elapsed: started ? Date.now() - started : -1,
      ...entry,
    };
    timeline.push(value);
    fs.appendFileSync(
      testInfo.outputPath("progress-timeline.jsonl"),
      `${JSON.stringify(value)}\n`,
    );
  };
  let completed = false;
  let id: string | undefined;
  const source = reviewFixture();
  const targetPath = writeFixture(project, source);
  try {
    const stopTraffic = [
      recordReconcileTraffic(page, "A", testInfo),
      recordReconcileTraffic(second, "B", testInfo),
    ];
    expect(Buffer.byteLength(source)).toBeGreaterThan(100 * 1024);
    for (const view of [page, second]) {
      await view.addInitScript(installMeasurements);
      view.on("worker", (worker) => {
        if (worker.url().includes("revision-merge-worker"))
          comparisonWorkers.add(worker);
      });
    }
    id = await openReview(request, targetPath);
    const url = new URL(`/?comparison=${id}`, testInfo.project.use.baseURL)
      .href;
    await Promise.all([page.goto(url), second.goto(url)]);
    await Promise.all([ready(page), ready(second)]);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(source);
    await expectOriginalComments(request, id, source);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(source);
    for (const stop of stopTraffic) stop();
    const initialization = await Promise.all(
      [page, second].map((view) =>
        view.evaluate(() => ({
          startedAt: performance.timeOrigin,
          completedAt: Date.now(),
          profile: Reflect.get(window, "roughdraftProfile"),
          profileOverflow: Reflect.get(window, "liveProfileOverflow"),
          longTasks: Reflect.get(window, "liveLongTasks"),
          api: Reflect.get(window, "liveApiEvents"),
        })),
      ),
    );
    fs.writeFileSync(
      testInfo.outputPath("initialization-profile.json"),
      JSON.stringify(initialization, null, 2),
    );

    const captured = new Set<string>();
    for (const [name, view] of [
      ["A", page],
      ["B", second],
    ] as const) {
      await view.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
        const received = Date.now();
        const sent = route.request().postDataJSON() as ReconcileRequest;
        const own =
          sent.draft.markdown.split(`Live owner ${name}:`)[1]?.split("\n")[0] ??
          "";
        recordTime({
          kind: "request",
          page: name,
          operationId: sent.operationId,
          generation: sent.localGeneration,
          reserved: Boolean(sent.reservationToken),
          own,
        });
        // Hold actual user-edit requests, not any projection-only initialization.
        if (
          !captured.has(name) &&
          own !== " unchanged." &&
          own.includes("unchanged.")
        ) {
          captured.add(name);
          recordTime({ kind: "gate-captured", page: name });
          if (captured.size === 2) {
            recordTime({ kind: "gate-released" });
            gate.resolve();
          }
          await gate.promise;
        }
        recordTime({
          kind: "route-continued",
          page: name,
          operationId: sent.operationId,
          heldMs: Date.now() - received,
        });
        try {
          await route.continue();
        } catch (error) {
          if (!closing) throw error;
        }
      });
      view.on("response", async (response) => {
        if (!response.url().endsWith(`/${id}/reconcile`)) return;
        const received = Date.now();
        recordTime({ kind: "response-received", page: name });
        try {
          const body = (await response.json()) as SyncResult;
          const sent = response.request().postDataJSON() as ReconcileRequest;
          const own =
            sent.draft.markdown
              .split(`Live owner ${name}:`)[1]
              ?.split("\n")[0] ?? "";
          recordTime({
            kind: "response-parsed",
            page: name,
            status: body.status,
            operationId: sent.operationId,
            received,
            parseMs: Date.now() - received,
            reservationExpiresAt: body.reservation?.expiresAt,
            reservationRevision: body.reservation?.revision,
            retryAfter: body.retryAfter,
            message: body.message,
            own,
          });
          responses.push({
            page: name,
            status: body.status,
            revision: body.state?.revision,
            at: started ? Date.now() - started : -1,
            own,
          });
          if (body.status === "client-merge-required") fallbackCount++;
          if (
            body.status !== "committed" ||
            !own.startsWith(" unchanged.") ||
            own === " unchanged." ||
            seen[name].has(own)
          )
            return;
          seen[name].add(own);
          counts[name].push(Date.now() - started);
          if (counts.A.length && counts.B.length) firstCommits.resolve();
        } catch {
          /* A closing page may cancel response-body inspection. */
        }
      });
      await owner(view, name).click();
      await view.keyboard.press("End");
    }
    const a = ` LocalA-${"abcdefghij".repeat(14)}`,
      b = ` LocalB-${"klmnopqrst".repeat(14)}`;
    started = Date.now();
    recordTime({ kind: "typing-started" });
    const typing = Promise.all([
      page.keyboard.type(a, { delay: 65 }),
      second.keyboard.type(b, { delay: 65 }),
    ]);
    void typing.catch(() => {}); // The original assertion remains primary if cleanup cancels typing.
    const verify = expect.configure({ soft: true });
    let progressDeadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        firstCommits.promise,
        new Promise<never>((_resolve, reject) => {
          progressDeadline = setTimeout(
            () =>
              reject(
                new Error(
                  `Both pages must commit within two seconds while typing: ${JSON.stringify({ counts, responses })}`,
                ),
              ),
            2000,
          );
        }),
      ]);
    } catch (error) {
      recordTime({
        kind: "first-commit-deadline-failed",
        message: error instanceof Error ? error.message : String(error),
        counts: { A: [...counts.A], B: [...counts.B] },
      });
      verify(
        error,
        "Both pages must commit within two seconds while typing",
      ).toBeUndefined();
    } finally {
      if (progressDeadline) clearTimeout(progressDeadline);
    }
    await typing;
    const typingEnded = Date.now() - started;
    const samples = await Promise.all(
      [page, second].map((view) =>
        view.evaluate(() => {
          const scope = window as Window & {
            liveInputDelays: number[];
            liveMergeMetrics: {
              workers: number;
              jobs: number;
              replies: number;
            };
          };
          const sorted = [...scope.liveInputDelays].sort(
            (left, right) => left - right,
          );
          return {
            count: sorted.length,
            p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            max: Math.max(0, ...sorted),
            merges: scope.liveMergeMetrics,
            api: Reflect.get(window, "liveApiEvents"),
          };
        }),
      ),
    );
    const inputPath = testInfo.outputPath("input-to-frame.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({ samples, typingEnded }, null, 2),
    );
    await testInfo.attach("input-to-frame.json", {
      path: inputPath,
      contentType: "application/json",
    });
    verify(
      samples.reduce((sum, sample) => sum + sample.merges.jobs, 0),
    ).toBeGreaterThan(0);
    verify(
      samples.reduce((sum, sample) => sum + sample.merges.replies, 0),
    ).toBeGreaterThan(0);
    verify(
      samples.every(
        (sample) => sample.count > 100 && sample.p95 < 150 && sample.max < 1000,
      ),
    ).toBe(true);
    await verify
      .poll(async () => {
        const value = await (
          await request.get(`${api}/${id}`, { headers })
        ).json();
        const text = value.draft?.cleanMarkdown ?? "";
        return text.includes(a) && text.includes(b);
      })
      .toBe(true);
    await verify(richTextEditor(page)).toContainText(b);
    await verify(richTextEditor(second)).toContainText(a);
    await verify
      .poll(
        () =>
          fs.readFileSync(targetPath, "utf8").includes(a) &&
          fs.readFileSync(targetPath, "utf8").includes(b),
      )
      .toBe(true);
    verify(fs.readFileSync(targetPath, "utf8")).not.toContain(
      "The release supports offline review",
    );
    const savedReview = await (
      await request.get(`${api}/${id}`, { headers })
    ).json();
    const proposalContent = (markdown: string) =>
      extractRoughdraftReviewIndex(markdown)
        .items.filter((item) => item.kind === "suggestion")
        .map((item) => ({
          id: item.id,
          kind: item.suggestionKind,
          original: item.originalText,
          proposed: item.replacementText,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    verify(proposalContent(savedReview.draft?.markdown ?? "")).toEqual(
      proposalContent(source),
    );
    verify(savedComments(savedReview.reviewComments ?? [])).toEqual(
      originalComments(source),
    );

    for (const view of [page, second])
      await verify(view.getByTestId("revision-conflict")).toHaveCount(0);
    for (const times of Object.values(counts)) {
      verify(times.length).toBeGreaterThan(3);
      const sorted = [...times].sort((left, right) => left - right);
      verify(
        Math.max(
          ...sorted.map((time, index) => time - (sorted[index - 1] ?? 0)),
          typingEnded - (sorted.at(-1) ?? 0),
        ),
      ).toBeLessThan(2000);
    }
    verify(fallbackCount).toBeGreaterThan(0);
    verify(comparisonWorkers.size).toBeGreaterThan(0);
    completed = testInfo.errors.length === 0;
  } finally {
    gate.resolve();
    firstCommits.resolve();
    await testInfo.attach("live-update-progress.json", {
      body: JSON.stringify(
        {
          bytes: Buffer.byteLength(source),
          counts,
          fallbackCount,
          comparisonWorkers: comparisonWorkers.size,
          responses,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    if (!completed) {
      await failureViews(testInfo, [page, second], "ui-at-failure.json");
      await failureSnapshot(testInfo, targetPath, id);
      await failureViews(testInfo, [page, second]);
    }
    // Cancel remaining keyboard input after a failed deadline before fixture
    // teardown collects its trace; otherwise typing outlives the assertion.
    closing = true;
    await page.close();
    await other.close();
    fs.writeFileSync(
      testInfo.outputPath("progress-summary.json"),
      JSON.stringify({ started, counts, responses, timeline }, null, 2),
    );
    removeMarkdownProject(project);
  }
});

test("reload retains newer typing and a peer edit after a committed own response was held", async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(45_000);
  const project = createMarkdownProject("live-held-ack");
  const source = reviewFixture(0);
  const targetPath = writeFixture(project, source);
  const other = await browser.newContext();
  const second = await other.newPage();
  const ownCommit = deferred(),
    ownResponse = deferred(),
    incoming = deferred();
  let blockIncoming = true,
    held = false,
    reloaded = false,
    completed = false;
  let id: string | undefined;
  let heldOperation: string | undefined;
  try {
    const stopTraffic = [
      recordReconcileTraffic(page, "A", testInfo),
      recordReconcileTraffic(second, "B", testInfo),
    ];
    id = await openReview(request, targetPath);
    const url = new URL(`/?comparison=${id}`, testInfo.project.use.baseURL)
      .href;
    await Promise.all([page.goto(url), second.goto(url)]);
    await Promise.all([ready(page), ready(second)]);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(source);
    await expectOriginalComments(request, id, source);
    expect(fs.readFileSync(targetPath, "utf8")).toBe(source);
    for (const stop of stopTraffic) stop();
    await page.route(`**/api/comparisons/${id}/state**`, async (route) => {
      if (blockIncoming) await incoming.promise;
      try {
        await route.continue();
      } catch {
        if (!reloaded)
          throw new Error("An active state request was unexpectedly cancelled");
      }
    });
    await page.route(`**/api/comparisons/${id}/reconcile`, async (route) => {
      const sent = route.request().postDataJSON() as ReconcileRequest;
      const response = await route.fetch();
      const result = (await response.json()) as SyncResult;
      if (
        !held &&
        result.status === "committed" &&
        sent.draft.markdown.includes("LocalA-first")
      ) {
        held = true;
        heldOperation = sent.operationId;
        ownCommit.resolve();
        await ownResponse.promise;
      }
      try {
        await route.fulfill({ response });
      } catch {
        if (!reloaded)
          throw new Error("An active save response was unexpectedly cancelled");
      }
    });
    await append(page, "A", " LocalA-first");
    await awaitSignal(ownCommit.promise, "the committed save response barrier");
    await append(second, "B", " LocalB-peer");
    await expect
      .poll(async () => {
        const value = await (
          await request.get(`${api}/${id}`, { headers })
        ).json();
        return (
          value.draft?.cleanMarkdown?.includes("LocalB-peer") &&
          value.draft?.cleanMarkdown?.includes("LocalA-first")
        );
      })
      .toBe(true);
    await append(page, "A", " LocalA-later");
    await expect(owner(page, "A")).toContainText("LocalA-first LocalA-later");
    reloaded = true;
    blockIncoming = false;
    await page.reload();
    await ready(page);
    await expect(owner(page, "A")).toContainText("LocalA-first LocalA-later");
    await expect(owner(page, "B")).toContainText("LocalB-peer");
    incoming.resolve();
    ownResponse.resolve();
    await expect
      .poll(() => {
        const text = fs.readFileSync(targetPath, "utf8");
        return (
          text.includes("LocalA-first LocalA-later") &&
          text.includes("LocalB-peer")
        );
      })
      .toBe(true);
    const text = fs.readFileSync(targetPath, "utf8");
    expect(text.match(/LocalA-first/g)).toHaveLength(1);
    expect(text.match(/LocalA-later/g)).toHaveLength(1);
    expect(text.match(/LocalB-peer/g)).toHaveLength(1);
    expect(text).not.toContain("The release supports offline review");
    await expectOriginalComments(request, id, source);
    for (const view of [page, second])
      await expect(view.getByTestId("revision-conflict")).toHaveCount(0);
    const recoveryPath = testInfo.outputPath("held-ack-reload.json");
    fs.writeFileSync(
      recoveryPath,
      JSON.stringify(
        { heldOperation, held, reloaded, exactCopies: 1 },
        null,
        2,
      ),
    );
    await testInfo.attach("held-ack-reload.json", {
      path: recoveryPath,
      contentType: "application/json",
    });
    completed = true;
  } finally {
    blockIncoming = false;
    reloaded = true;
    incoming.resolve();
    ownResponse.resolve();
    ownCommit.resolve();
    if (!completed) {
      await failureViews(testInfo, [page, second]);
      await failureSnapshot(testInfo, targetPath, id);
    }
    await other.close();
    removeMarkdownProject(project);
  }
});
