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
  try {
    scope.postMessage({
      id: data.id,
      result: mergeReviewDrafts(
        data.base,
        data.local,
        data.incoming,
        data.options,
      ),
    });
  } catch {
    scope.postMessage({
      id: data.id,
      result: {
        status: "client-merge-required",
        draft: data.local,
        conflicts: [],
        signature: reviewDraftSignature(data.local),
        reason:
          "The outside update could not be compared safely. Your work is preserved.",
      },
    });
  }
};
