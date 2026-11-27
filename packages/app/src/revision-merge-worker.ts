import { mergeReviewDrafts, reviewDraftSignature } from "@roughdraft/rfm";
import type {
  MergeWorkerReply,
  MergeWorkerRequest,
} from "./revision-reconciliation";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MergeWorkerRequest>) => void) | null;
  postMessage: (reply: MergeWorkerReply) => void;
};
scope.onmessage = ({ data }) => {
  const began = performance.now();
  const startedAt = performance.timeOrigin + began;
  const reply = (result: MergeWorkerReply["result"]) => {
    scope.postMessage({
      id: data.id,
      result,
      timing: { startedAt, durationMs: performance.now() - began },
    });
  };
  try {
    reply(
      mergeReviewDrafts(data.base, data.local, data.incoming, data.options),
    );
  } catch {
    reply({
      status: "client-merge-required",
      draft: data.local,
      conflicts: [],
      signature: reviewDraftSignature(data.local),
      reason:
        "The outside update could not be compared safely. Your work is preserved.",
    });
  }
};
