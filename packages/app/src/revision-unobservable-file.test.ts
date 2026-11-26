import {
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
let controller: RevisionSessionController | undefined;
afterEach(() => {
  controller?.stop();
  controller = undefined;
  vi.useRealTimers();
});

test("a file whose outside changes are unobservable still sends its edits through guarded autosave", async () => {
  vi.useFakeTimers();
  const original: RevisionDraft = {
    markdown: "Mounted source.\n",
    cleanMarkdown: "Mounted source.\n",
    decisions: {},
    reviewComments: [],
  };
  let state: SyncState<ComparisonReviewData> = {
    review: {
      id: "mounted-file",
      revision: 1,
      mode: "document",
      title: "Edit a mounted agent instruction file",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: "/mounted.md",
      beforeText: original.markdown,
      afterText: original.markdown,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: false,
      editor: "unified",
      autosave: "/mounted.md",
      handoff: "chat",
      destinationPath: "/mounted.md",
      savedPath: "/mounted.md",
      savedText: original.markdown,
      draft: original,
    },
    draft: original,
    revision: 1,
    signature: reviewDraftSignature(original),
    registryGeneration: "1",
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
    disk: {
      path: "/mounted.md",
      version: "initial",
      hash: "initial",
      text: original.markdown,
      availability: "unobservable",
      message: "External changes cannot be observed for this mounted file",
    },
  };
  const writes: ReconcileRequest[] = [];
  controller = new RevisionSessionController(state.review, original, {
    storage: window.localStorage,
    tabStorage: window.sessionStorage,
    request: async <T>(path: string, body?: object): Promise<T | null> => {
      if (!body) return structuredClone(state) as T;
      if (path.endsWith("/checkpoint"))
        return { checkpointId: "recovery" } as T;
      if (!path.endsWith("/reconcile")) throw new Error(`Unexpected ${path}`);
      const request = body as ReconcileRequest;
      writes.push(request);
      if (!state.disk) throw new Error("Expected the mounted-file version");
      state = {
        ...state,
        draft: request.draft,
        revision: 2,
        signature: reviewDraftSignature(request.draft),
        registryGeneration: "2",
        review: {
          ...state.review,
          revision: 2,
          draft: request.draft,
          savedText: request.draft.cleanMarkdown,
        },
        disk: {
          ...state.disk,
          version: "saved",
          hash: "saved",
          text: request.draft.cleanMarkdown ?? request.draft.markdown,
        },
      };
      return { status: "committed", state: structuredClone(state) } as T;
    },
  });
  controller.setAdapter({
    apply: (value) => ({
      ...value,
      cleanMarkdown: value.cleanMarkdown ?? value.markdown,
    }),
    adopt: () => null,
    readUiDrafts: () => ({}),
    restoreUiDrafts: () => {},
  });
  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  controller.updateDraft(() => ({
    ...original,
    markdown: "Edited mounted source.\n",
    cleanMarkdown: "Edited mounted source.\n",
  }));
  expect(await controller.flush()).toBe(true);
  expect(writes).toHaveLength(1);
  expect(writes[0].writeFile).toBe(true);
  expect(writes[0].expectedDisk).toMatchObject({
    path: "/mounted.md",
    version: "initial",
    hash: "initial",
  });
  expect(state.review.savedText).toBe("Edited mounted source.\n");
  expect(controller.getSnapshot().writePaused).toBe(false);
});
