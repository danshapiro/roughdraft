import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import type { SyncState } from "@roughdraft/rfm";
import request from "supertest";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Comparison } from "./comparisons.js";
import { ComparisonOperations } from "./comparison-operations.js";
import { createApp } from "./index.js";

const parent = fileURLToPath(
  new URL("../../../.test-tmp/turn-handoff/", import.meta.url),
);
const original = `Owner A: old\n\nOwner B: old\n\nOwner C: old\n\n${"Unchanged ordinary paragraph preserves the complete review and its source spelling.\n\n".repeat(1400)}`;
let root: string;
let host: ReturnType<typeof createApp>;
let clock: number;

beforeEach(() => {
  clock = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  fs.mkdirSync(parent, { recursive: true });
  root = fs.mkdtempSync(path.join(parent, "run-"));
  host = createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  host.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  try {
    fs.rmdirSync(parent);
  } catch (error) {
    if (
      !["ENOENT", "ENOTEMPTY"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
});

function body(
  state: SyncState<Comparison>,
  operationId: string,
  page: string,
  markdown: string,
  sequence: number,
) {
  return {
    operationId,
    pageInstanceId: page,
    operationSequence: sequence,
    operationContext: state.operationContext,
    expectedRevision: state.revision,
    baseRevision: state.revision,
    baseSignature: state.signature,
    base: state.draft,
    draft: { ...state.draft, markdown, cleanMarkdown: markdown },
    expectedDisk: state.disk,
    writeFile: true,
    localGeneration: sequence,
    reason: "sync",
  };
}

async function releasedHolder() {
  const target = path.join(root, "source.md");
  fs.writeFileSync(target, original);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  expect(opened.status).toBe(201);
  const initial = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body as SyncState<Comparison>;
  const route = `/api/comparisons/${opened.body.id}/reconcile`;
  const seededText = original.replace("C: old", "C: seeded");
  const seeded = await request(host.app)
    .post(route)
    .send(body(initial, "seed", "seed", seededText, 1));
  expect(seeded.body.status).toBe("committed");

  const held = await request(host.app)
    .post(route)
    .send(
      body(initial, "a-held", "a", original.replace("A: old", "A: first"), 1),
    );
  expect(held.body.status).toBe("client-merge-required");
  const waiting = await request(host.app)
    .post(route)
    .send(
      body(
        seeded.body.state,
        "b-waiting",
        "b",
        seededText.replace("B: old", "B: waiting"),
        1,
      ),
    );
  expect(waiting.body.status).toBe("retry-later");

  const holderText = seededText.replace("A: old", "A: first");
  const committed = await request(host.app)
    .post(route)
    .send({
      ...body(held.body.state, "a-commit", "a", holderText, 2),
      reservationToken: held.body.reservation.token,
    });
  expect(committed.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(holderText);
  return {
    initial,
    state: committed.body.state as SyncState<Comparison>,
    route,
    target,
    holderText,
  };
}

test("the selected page commits its prepared current-base candidate on its first handoff request", async () => {
  const { state, route, target, holderText } = await releasedHolder();
  const denied = await request(host.app)
    .post(route)
    .send(body(state, "a-second", "a", holderText, 3));
  expect(denied.body.status).toBe("retry-later");

  const candidate = holderText.replace("B: old", "B: waiting");
  const saved = await request(host.app)
    .post(route)
    .send(body(state, "b-prepared-current", "b", candidate, 2));
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.revision).toBe(state.revision + 1);
  expect(fs.readFileSync(target, "utf8")).toBe(candidate);
});

test.each([
  "older-expected-revision",
  "older-base-revision",
  "different-base-signature",
  "wrong-owner",
  "wrong-token",
] as const)("a current-base handoff does not bypass the %s guard", async (mismatch) => {
  const { initial, state, route, target, holderText } = await releasedHolder();
  const denied = await request(host.app)
    .post(route)
    .send(body(state, "a-second", "a", holderText, 3));
  expect(denied.body.status).toBe("retry-later");

  const page = mismatch === "wrong-owner" ? "a" : "b";
  const sent = {
    ...body(
      state,
      "guarded-handoff",
      page,
      holderText.replace("B: old", "B: waiting"),
      page === "a" ? 4 : 2,
    ),
    ...(mismatch === "wrong-token" ? { reservationToken: "wrong-token" } : {}),
  };
  if (mismatch === "older-expected-revision") sent.expectedRevision -= 1;
  if (mismatch === "older-base-revision") sent.baseRevision -= 1;
  if (mismatch === "different-base-signature") {
    sent.base = initial.draft;
    sent.baseSignature = initial.signature;
  }
  const result = await request(host.app).post(route).send(sent);
  expect(result.body.status).toBe(
    mismatch === "wrong-owner" || mismatch === "wrong-token"
      ? "retry-later"
      : "client-merge-required",
  );
  if (result.body.state)
    expect(result.body.state.revision).toBe(state.revision);
  expect(fs.readFileSync(target, "utf8")).toBe(holderText);
});

test("a prepared current-base handoff cannot overwrite an outside edit made during operation journal writes", async () => {
  const { state, route, target, holderText } = await releasedHolder();
  const denied = await request(host.app)
    .post(route)
    .send(body(state, "a-second", "a", holderText, 3));
  expect(denied.body.status).toBe("retry-later");

  const write = fs.writeFileSync.bind(fs);
  const flush = fs.fsyncSync.bind(fs);
  let journalStarted = false;
  let outsideWritten = false;
  const outside = holderText.replace("C: seeded", "C: outside during journal");
  vi.spyOn(fs, "writeFileSync").mockImplementation(
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[1] === "string") {
        try {
          const value = JSON.parse(args[1]);
          if (
            value.phase === "running" &&
            value.operation?.operationId === "b-journal-race"
          )
            journalStarted = true;
        } catch {
          // Only this operation's real journal activates the outside writer.
        }
      }
      return write(...args);
    },
  );
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (journalStarted && !outsideWritten) {
      outsideWritten = true;
      write(target, outside);
    }
    return flush(fd);
  });
  const result = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "b-journal-race",
        "b",
        holderText.replace("B: old", "B: waiting"),
        2,
      ),
    );
  expect(outsideWritten).toBe(true);
  expect(result.body.status).toBe("incoming-changed");
  expect(result.body.state.revision).toBe(state.revision);
  expect(result.body.state.draft.markdown).toBe(holderText);
  expect(fs.readFileSync(target, "utf8")).toBe(outside);
});

test("a second current-base save cannot pass a queued page while that page prepares its current candidate", async () => {
  const { state, route, target, holderText } = await releasedHolder();
  const secondHolder = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "a-second",
        "a",
        holderText.replace("A: first", "A: second"),
        3,
      ),
    );
  expect(secondHolder.body.status).toBe("retry-later");
  expect(secondHolder.body.retryAfter).toBeGreaterThan(0);
  expect(secondHolder.body.retryAfter).toBeLessThanOrEqual(750);
  expect(fs.readFileSync(target, "utf8")).toBe(holderText);

  const candidate = holderText.replace("B: old", "B: waiting");
  let saved = await request(host.app)
    .post(route)
    .send(body(state, "b-prepared", "b", candidate, 2));
  if (saved.body.status === "client-merge-required") {
    expect(saved.body.reservation.revision).toBe(state.revision);
    saved = await request(host.app)
      .post(route)
      .send({
        ...body(saved.body.state, "b-commit", "b", candidate, 3),
        reservationToken: saved.body.reservation.token,
      });
  }
  expect(saved.body.status).toBe("committed");
  expect(saved.body.state.revision).toBe(state.revision + 1);
  expect(fs.readFileSync(target, "utf8")).toBe(candidate);
});

test("the queued stale page can obtain its handoff token without renewing it or lending it to the previous holder", async () => {
  const { initial, state, route, target, holderText } = await releasedHolder();
  const denied = await request(host.app)
    .post(route)
    .send(
      body(
        state,
        "a-second",
        "a",
        holderText.replace("A: first", "A: second"),
        3,
      ),
    );
  expect(denied.body.status).toBe("retry-later");

  const staleText = original.replace("B: old", "B: waiting");
  const selected = await request(host.app)
    .post(route)
    .send(body(initial, "b-stale", "b", staleText, 2));
  expect(selected.body.status).toBe("client-merge-required");
  const turn = selected.body.reservation;
  expect(turn.revision).toBe(state.revision);
  clock += 100;
  const repeated = await request(host.app)
    .post(route)
    .send(body(initial, "b-still-stale", "b", staleText, 3));
  expect(repeated.body.status).toBe("client-merge-required");
  expect(repeated.body.reservation).toEqual(turn);

  const wrongOwner = await request(host.app)
    .post(route)
    .send({
      ...body(
        state,
        "a-wrong-token",
        "a",
        holderText.replace("A: first", "A: second"),
        4,
      ),
      reservationToken: turn.token,
    });
  expect(wrongOwner.body.status).toBe("retry-later");
  const candidate = holderText.replace("B: old", "B: waiting");
  const saved = await request(host.app)
    .post(route)
    .send({
      ...body(state, "b-commit", "b", candidate, 4),
      reservationToken: turn.token,
    });
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(candidate);
});

test("a closed queued page does not block an otherwise valid current-base save after 750ms", async () => {
  const { state, route, target, holderText } = await releasedHolder();
  const nextText = holderText.replace("A: first", "A: second");
  const retry = (id: string, sequence: number) =>
    request(host.app)
      .post(route)
      .send(body(state, id, "a", nextText, sequence));
  const denied = await retry("a-second", 3);
  expect(denied.body.status).toBe("retry-later");
  expect(denied.body.retryAfter).toBe(750);
  clock += 749;
  const stillDenied = await retry("a-before-expiry", 4);
  expect(stillDenied.body.status).toBe("retry-later");
  expect(stillDenied.body.retryAfter).toBe(1);
  clock += 1;
  const saved = await retry("a-after-expiry", 5);
  expect(saved.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(nextText);
});

test("a denied compact peer's journal leaves the prepared holder within its unchanged turn", async () => {
  const target = path.join(root, "source.md");
  const text = original.slice(0, 20 * 1024);
  fs.writeFileSync(target, text);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  const route = `/api/comparisons/${opened.body.id}/reconcile`;
  const state = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body as SyncState<Comparison>;
  const candidate = text.replace("B: old", "B: prepared");
  const heldBody = {
    ...body(state, "prepared-holder", "b", candidate, 1),
    baseSignature: "unavailable-browser-baseline",
  };
  const held = await request(host.app).post(route).send(heldBody);
  expect(held.body.status).toBe("base-unavailable");
  const turn = held.body.reservation;
  clock += 200;

  const realSync = fs.fsyncSync;
  const flush = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    realSync(fd);
    // Charge slow storage at the real journal boundary. Six flushes exhaust
    // the remaining 550 ms; the two required atomic writes leave 150 ms.
    clock += 100;
  });
  const denied = await request(host.app)
    .post(route)
    .set("X-Roughdraft-Sync", "compact-v2")
    .send(body(state, "denied-peer", "c", text, 1));
  const flushes = flush.mock.calls.length;
  flush.mockRestore();
  expect(denied.body.status).toBe("retry-later");
  expect(denied.body.retryAfter).toBeGreaterThan(0);
  expect(denied.body.retryAfter).toBeLessThanOrEqual(550);

  const replay = await request(host.app).post(route).send(heldBody);
  expect(replay.body.reservation).toEqual(turn);
  const saved = await request(host.app)
    .post(route)
    .send({
      ...body(state, "prepared-holder-commit", "b", candidate, 2),
      reservationToken: turn.token,
    });
  expect(saved.body.status).toBe("committed");
  expect(flushes).toBe(4);
  expect(fs.readFileSync(target, "utf8")).toBe(candidate);
});

test.each([
  125, 250,
])("the first delivered merge turn excludes real journal flushes costing %d ms each without renewing on replay or restart", async (flushCost) => {
  const target = path.join(root, "source.md");
  // The complete outcome still uses its compressed, separately durable payload.
  const text = original.slice(0, 20 * 1024);
  fs.writeFileSync(target, text);
  const opened = await request(host.app)
    .post("/api/comparisons/document")
    .send({ targetPath: target, autosave: target });
  expect(opened.status).toBe(201);
  const route = `/api/comparisons/${opened.body.id}/reconcile`;
  const state = (
    await request(host.app).get(`/api/comparisons/${opened.body.id}/state`)
  ).body as SyncState<Comparison>;
  const operationId = "journal-handoff";
  const sent = {
    ...body(state, operationId, "b", text.replace("B: old", "B: waiting"), 2),
    baseSignature: "unavailable-browser-baseline",
  };
  const journalStarted = clock;
  const operationTime = state.operationContext.acceptUntil - 120_000;
  let flushes = 0;
  const originalPrepare = ComparisonOperations.prototype.prepare;
  const realSync = fs.fsyncSync;
  const preparing = vi
    .spyOn(ComparisonOperations.prototype, "prepare")
    .mockImplementation(function (...args) {
      if (args[0].operation.operationId !== operationId)
        return originalPrepare.apply(this, args);
      const flush = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        realSync(fd);
        // Isolate slow storage at the actual durable-write boundary. Product
        // and browser clocks remain unchanged; only this unit test owns time.
        clock += flushCost;
        flushes++;
      });
      try {
        return originalPrepare.apply(this, args);
      } finally {
        flush.mockRestore();
      }
    });
  const response = await request(host.app).post(route).send(sent);
  preparing.mockRestore();
  expect(response.body.status).toBe("base-unavailable");
  expect(flushes).toBeGreaterThanOrEqual(4);
  const turn = response.body.reservation;
  const finishedAt = operationTime + clock - journalStarted;
  expect(turn.expiresAt - finishedAt).toBe(750);

  const journal = path.join(root, "comparisons", "operations");
  const headerPath = path.join(journal, `${operationId}.json`);
  const headerBefore = fs.readFileSync(headerPath);
  const header = JSON.parse(headerBefore.toString());
  const payloadPath = path.join(journal, "payloads", header.resultPayload.file);
  const payloadBefore = fs.readFileSync(payloadPath);
  const persisted = JSON.parse(gunzipSync(payloadBefore).toString());
  expect(persisted.status).toBe(response.body.status);
  expect(persisted.state.draft).toEqual(response.body.state.draft);
  expect(persisted.reservation.token).toBe(turn.token);
  expect(persisted.reservation.expiresAt).toBe(
    turn.expiresAt - flushes * flushCost,
  );

  clock += 100;
  const replay = await request(host.app).post(route).send(sent);
  expect(replay.body.reservation).toEqual(turn);
  const status = await request(host.app).get(
    `/api/comparisons/operations/${operationId}`,
  );
  expect(status.body.reservation).toEqual(turn);
  expect(status.body.state.draft).toEqual(response.body.state.draft);
  expect(fs.readFileSync(headerPath)).toEqual(headerBefore);
  expect(fs.readFileSync(payloadPath)).toEqual(payloadBefore);

  // A process restart retains the outcome, not the ephemeral live lease.
  host.dispose();
  // Keep this restart inside the delivered lease in the isolated unit clock;
  // real fixture I/O must not make a restored-turn regression pass by expiry.
  vi.spyOn(Date, "now").mockReturnValue(finishedAt + 100);
  host = createApp({
    homeDir: root,
    comparisonsDir: path.join(root, "comparisons"),
    staticDirPath: root,
  });
  const restored = await request(host.app).get(
    `/api/comparisons/operations/${operationId}`,
  );
  expect(restored.body.reservation).toEqual(persisted.reservation);
  expect(restored.body.state.draft).toEqual(persisted.state.draft);
  expect(
    turn.expiresAt -
      (restored.body.state.operationContext.acceptUntil - 120_000),
  ).toBe(650);
  const fresh = restored.body.state;
  const nextText = text.replace("A: old", "A: after restart");
  const next = await request(host.app)
    .post(route)
    .send(body(fresh, "after-journal-restart", "a", nextText, 1));
  expect(next.body.status).toBe("committed");
  expect(fs.readFileSync(target, "utf8")).toBe(nextText);
});
