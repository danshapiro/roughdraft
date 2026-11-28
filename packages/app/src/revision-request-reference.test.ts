import {
  reviewDraftSignature,
  type SyncResult,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { transferSyncResponse } from "../../server/src/comparison-sync-transfer";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
  requestRevisionSync,
} from "./revision-session";

const controllers: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function draft(markdown = "The serialized working source.\r\n"): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: markdown,
    decisions: {},
    reviewComments: [
      {
        id: "c1",
        changeId: "document",
        content: "Saved feedback.",
        createdAt: "2026-11-26T12:00:00.000Z",
      },
    ],
  };
}
function state(value = draft(), revision = 1): SyncState<ComparisonReviewData> {
  return {
    review: {
      id: "request-reference",
      referenceVersion: "frozen-source-v1",
      revision,
      mode: "document",
      title: "Review exact request text",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: "Frozen original.\r\n",
      afterText: "Frozen working source.\r\n",
      segments: [],
      comment: "",
      reviewComments: value.reviewComments,
      status: "open",
      completion: null,
      targetChanged: false,
      editor: "unified",
      autosave: "none",
      handoff: "chat",
      destinationPath: null,
      savedPath: null,
      savedText: value.cleanMarkdown,
      draft: value,
    },
    draft: value,
    revision,
    signature: reviewDraftSignature(value),
    disk: null,
    registryGeneration: String(revision),
    operationContext: {
      owner: "owner",
      epoch: "epoch",
      acceptUntil: Date.now() + 120_000,
    },
  };
}
function packet(
  full: SyncState<ComparisonReviewData>,
  headers: Headers,
  sent: RevisionDraft,
) {
  return transferSyncResponse(
    { status: "committed", state: full },
    full.review.id,
    headers.get("X-Roughdraft-Reference") ?? undefined,
    "compact-v2",
    {
      signature: headers.get("X-Roughdraft-Draft-Reference") ?? "",
      draft: sent,
    },
  );
}

test("only identical concurrent state reads share bytes, and settled reads are never cached", async () => {
  const previous = state().review;
  const finishes: Array<() => void> = [];
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) =>
        finishes.push(() => resolve(new Response(null, { status: 304 }))),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const first = requestRevisionSync(
    "/request-reference/state",
    undefined,
    "registry-one",
    previous,
  );
  const same = requestRevisionSync(
    "/request-reference/state",
    undefined,
    "registry-one",
    previous,
  );
  const changedTag = requestRevisionSync(
    "/request-reference/state",
    undefined,
    "registry-two",
    previous,
  );
  const changedReference = requestRevisionSync(
    "/request-reference/state",
    undefined,
    "registry-one",
    { ...previous, referenceVersion: "frozen-source-v2" },
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
  for (const finish of finishes.splice(0)) finish();
  expect(
    await Promise.all([first, same, changedTag, changedReference]),
  ).toEqual([null, null, null, null]);
  const fresh = requestRevisionSync(
    "/request-reference/state",
    undefined,
    "registry-one",
    previous,
  );
  expect(fetcher).toHaveBeenCalledTimes(4);
  finishes.shift()?.();
  expect(await fresh).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

test("concurrent mutations remain independent even when their paths and bodies match", async () => {
  const finishes: Array<() => void> = [];
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) =>
        finishes.push(() => resolve(Response.json({ status: "committed" }))),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const first = requestRevisionSync("/request-reference/reconcile", {
    draft: draft(),
  });
  const second = requestRevisionSync("/request-reference/reconcile", {
    draft: draft(),
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const finish of finishes) finish();
  expect(await Promise.all([first, second])).toEqual([
    { status: "committed" },
    { status: "committed" },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("the real fetch path uses immutable serialized request text after the caller changes its body", async () => {
  const previous = state();
  const body = { draft: draft("Exact sent source.\r\n") };
  let release: ((response: Response) => void) | undefined;
  let sent: RevisionDraft | undefined;
  let wire: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const submitted = JSON.parse(String(init.body)).draft as RevisionDraft;
      sent = submitted;
      expect(headers.get("X-Roughdraft-Sync")).toBe("compact-v2");
      expect(headers.get("X-Roughdraft-Draft-Reference")).toBe(
        reviewDraftSignature(submitted),
      );
      const saved = state(
        {
          ...submitted,
          reviewComments: submitted.reviewComments.map((comment) => ({
            ...comment,
            authorId: null,
          })),
        },
        2,
      );
      wire = packet(saved, headers, submitted);
      expect(wire).toMatchObject({ state: { draftTextFromRequest: true } });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );
  const pending = requestRevisionSync<SyncResult<ComparisonReviewData>>(
    "/request-reference/reconcile",
    body,
    undefined,
    previous.review,
  );
  body.draft.markdown = "Newer caller source that was never sent.";
  body.draft.cleanMarkdown = "Newer caller clean text that was never sent.";
  body.draft.reviewComments[0].content = "Newer caller comment.";
  if (!release) throw new Error("Expected the actual serialized fetch request");
  release(new Response(JSON.stringify(wire), { status: 200 }));
  const received = await pending;
  expect(received?.state?.draft).toEqual({
    ...sent,
    reviewComments: sent?.reviewComments.map((comment) => ({
      ...comment,
      authorId: null,
    })),
  });
  expect(received?.state?.draft.markdown).toBe("Exact sent source.\r\n");
  expect(received?.state?.review.savedText).toBe("Exact sent source.\r\n");
  expect(received?.state?.review.beforeText).toBe(previous.review.beforeText);
});

test("the default controller fetch path decodes a request reference once before acknowledging the save", async () => {
  let server = state();
  let aliases = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "GET")
        return new Response(JSON.stringify(server), { status: 200 });
      const sent = JSON.parse(String(init.body));
      server = state(sent.draft, server.revision + 1);
      server.review.lastOperation = {
        id: sent.operationId,
        pageInstanceId: sent.pageInstanceId,
        reason: sent.reason,
      };
      const wire = packet(server, new Headers(init.headers), sent.draft);
      expect(wire).toMatchObject({ state: { draftTextFromRequest: true } });
      aliases++;
      return new Response(JSON.stringify(wire), { status: 200 });
    }),
  );
  const memory = () => ({
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    key: () => null,
    length: 0,
  });
  const controller = new RevisionSessionController(
    server.review,
    server.draft as RevisionDraft,
    {
      storage: memory(),
      tabStorage: memory(),
    },
  );
  controllers.push(controller);
  controller.setAdapter({
    apply: (value) => value,
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  await controller.refresh(true);
  controller.updateDraft(() =>
    draft("Typed through the default controller.\r\n"),
  );
  expect(await controller.flush()).toBe(true);
  expect(aliases).toBe(1);
  expect(controller.getSnapshot().conflict).toBeNull();
  expect(controller.getSnapshot().session.draft?.markdown).toBe(
    "Typed through the default controller.\r\n",
  );
  expect(controller.getSnapshot().session.savedText).toBe(
    "Typed through the default controller.\r\n",
  );
});

test.each([
  "GET",
  "copy",
] as const)("the real %s path never advertises a request draft it did not send", async (kind) => {
  const previous = state();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      expect(
        new Headers(init.headers).has("X-Roughdraft-Draft-Reference"),
      ).toBe(false);
      return new Response(JSON.stringify(previous), { status: 200 });
    }),
  );
  const received = await requestRevisionSync<SyncState<ComparisonReviewData>>(
    "/request-reference/state",
    kind === "copy" ? { workingDraft: draft() } : undefined,
    undefined,
    previous.review,
  );
  expect(received).toEqual(previous);
});
