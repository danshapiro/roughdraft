import {
  mergeReviewDrafts,
  type ReconcileRequest,
  reviewDraftSignature,
  type SyncState,
} from "@roughdraft/rfm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComparisonReviewData } from "./comparison-types";
import {
  type RevisionDraft,
  RevisionSessionController,
} from "./revision-session";

vi.mock("./revision-live-transport", () => ({
  subscribeReviewChanges: () => () => {},
}));
class MemoryStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}
const original =
  "The planting schedule is ready.\n\nThe lighting schedule is ready.\n";
const local = original.replace("planting", "orchard");
const incoming = original.replace("planting", "garden");
function draft(markdown: string): RevisionDraft {
  return {
    markdown,
    cleanMarkdown: markdown,
    decisions: {},
    reviewComments: [],
  };
}
function state(
  markdown: string,
  revision = 1,
): SyncState<ComparisonReviewData> {
  const current = draft(markdown);
  return {
    review: {
      id: "resolution-retry",
      revision,
      mode: "document",
      title: "Resolve a release-plan change while another page saves",
      beforeLabel: "Original",
      afterLabel: "Working",
      targetPath: null,
      beforeText: original,
      afterText: original,
      segments: [],
      comment: "",
      reviewComments: [],
      status: "open",
      completion: null,
      targetChanged: false,
      editor: "unified",
      autosave: "none",
      handoff: "chat",
      destinationPath: null,
      savedPath: null,
      savedText: null,
      draft: current,
    },
    draft: current,
    revision,
    signature: reviewDraftSignature(current),
    disk: null,
    operationContext: {
      owner: "test",
      epoch: "one",
      acceptUntil: Date.now() + 120_000,
    },
    registryGeneration: String(revision),
  };
}
const controllers: RevisionSessionController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-26T12:00:00.000Z"));
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
  vi.useRealTimers();
});

for (const [choice, leaseAttempt] of [
  ["local", "ordinary"],
  ["incoming", "ordinary"],
  ["local", "reserved"],
  ["incoming", "reserved"],
] as const) {
  test.each([
    "independent",
    "overlapping",
  ] as const)(`an explicitly confirmed ${choice} resolution waits when its ${leaseAttempt} attempt meets a peer's merge turn and guards a later %s update`, async (change) => {
    let server = state(original);
    const attempts: ReconcileRequest[] = [];
    const checkpoint = vi.fn();
    const controller = new RevisionSessionController(
      server.review,
      draft(original),
      {
        storage: new MemoryStorage(),
        tabStorage: new MemoryStorage(),
        id: () => "resolving-page",
        request: async <T>(path: string, body?: object): Promise<T | null> => {
          if (!body) return structuredClone(server) as T;
          if (path.endsWith("/checkpoint")) {
            checkpoint(body);
            return {
              checkpointId: `recovery-${checkpoint.mock.calls.length}`,
            } as T;
          }
          if (!path.endsWith("/reconcile"))
            throw new Error(`Unexpected ${path}`);
          const request = body as ReconcileRequest;
          expect(request.reason).toBe("resolve");
          attempts.push(request);
          if (leaseAttempt === "reserved" && attempts.length === 1)
            return {
              status: "client-merge-required",
              state: structuredClone(server),
              reservation: {
                token: "initial-turn",
                revision: server.revision,
                expiresAt: Date.now() + 750,
              },
            } as T;
          const leaseIndex = leaseAttempt === "reserved" ? 2 : 1;
          if (attempts.length === leaseIndex) {
            // The user confirmed while another page still has 241 ms left.
            server = state(
              incoming
                .replace("lighting", "lantern")
                .replace(
                  "garden",
                  change === "overlapping" ? "terrace" : "garden",
                ),
              3,
            );
            return {
              status: "retry-later",
              retryAfter: 241,
              state: structuredClone(server),
            } as T;
          }
          const inspected = mergeReviewDrafts(
            draft(original),
            draft(local),
            server.draft,
            { server: false },
          );
          if (inspected.status !== "conflict")
            throw new Error("Expected the inspected passage to conflict");
          if (request.resolution?.signature !== inspected.signature)
            return {
              status: "conflict",
              state: structuredClone(server),
              merge: inspected,
            } as T;
          const resolved = mergeReviewDrafts(
            draft(original),
            draft(local),
            server.draft,
            {
              server: false,
              resolution: request.resolution.choice,
            },
          );
          if (resolved.status !== "merged")
            throw new Error("Expected the confirmed choice to resolve");
          server = state(resolved.draft.markdown, 4);
          return { status: "committed", state: structuredClone(server) } as T;
        },
      },
    );
    controllers.push(controller);
    controller.setAdapter({
      apply: (value) => ({
        ...value,
        cleanMarkdown: value.cleanMarkdown ?? value.markdown,
      }),
      adopt: () => null,
      readUiDrafts: () => ({}),
      restoreUiDrafts: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.updateDraft(() => draft(local));
    server = state(incoming, 2);
    await controller.refresh(true);
    const conflict = controller.getSnapshot().conflict;
    expect(conflict?.kind).toBe("conflict");
    if (!conflict) throw new Error("Expected an inspectable conflict");
    const confirmation = controller.resolveConflict(choice, conflict.signature);
    await vi.advanceTimersByTimeAsync(1000);
    const committed = await confirmation;

    expect(attempts).toHaveLength(leaseAttempt === "reserved" ? 3 : 2);
    const retry = attempts.at(-1);
    if (!retry) throw new Error("Expected the confirmed resolution to retry");
    expect(new Set(attempts.map((attempt) => attempt.operationId)).size).toBe(
      attempts.length,
    );
    expect(retry.resolution).toMatchObject({
      signature: conflict.signature,
      choice,
      checkpointIds: ["recovery-1", "recovery-2"],
      checkpointGenerations: { "recovery-1": 1, "recovery-2": 2 },
    });
    expect(checkpoint).toHaveBeenCalled();
    if (change === "independent") {
      expect(committed).toBe(true);
      expect(server.draft.markdown).toContain(
        choice === "local" ? "orchard schedule" : "garden schedule",
      );
      expect(server.draft.markdown).toContain("lantern schedule");
      expect(controller.readDraft().markdown).toBe(server.draft.markdown);
      expect(controller.getSnapshot().conflict).toBeNull();
      expect(controller.getSnapshot().writePaused).toBe(false);
    } else {
      expect(committed).toBe(false);
      expect(server.draft.markdown).toContain("terrace schedule");
      expect(controller.getSnapshot().conflict?.kind).toBe("conflict");
      expect(controller.getSnapshot().conflict?.signature).not.toBe(
        conflict.signature,
      );
      expect(controller.getSnapshot().writePaused).toBe(true);
    }
  });
}
