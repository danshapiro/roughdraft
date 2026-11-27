import type { SyncDraft } from "@roughdraft/rfm";
import { CommentEditorList } from "./CommentEditorList";

export function RevisionOutdatedFeedback({ draft }: { draft: SyncDraft }) {
  if (!draft.outdatedSuggestions?.length) return null;
  return (
    <section
      className="mt-4 space-y-3"
      data-testid="revision-outdated-feedback"
      aria-label="Outdated proposals"
    >
      <h2 className="font-semibold">Outdated proposals</h2>
      <p className="text-sm text-muted-foreground">
        The file changed across these proposals. Their original feedback is
        preserved for the agent.
      </p>
      {draft.outdatedSuggestions.map((proposal) => {
        const included = new Set([proposal.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const comment of draft.reviewComments)
            if (
              !included.has(comment.id) &&
              (included.has(comment.changeId) ||
                included.has(comment.parentCommentId ?? ""))
            ) {
              included.add(comment.id);
              changed = true;
            }
        }
        const replies = draft.reviewComments
          .filter((comment) => included.has(comment.id))
          .map((comment) => ({
            ...comment,
            parentCommentId:
              included.has(comment.parentCommentId ?? "") &&
              comment.parentCommentId !== proposal.id
                ? comment.parentCommentId
                : null,
          }));
        return (
          <article key={proposal.id} className="space-y-2 rounded border p-3">
            <h3 className="font-medium">Proposal {proposal.id}</h3>
            <p className="text-sm">
              {proposal.authorType === "ai"
                ? "AI"
                : (proposal.authorId ?? "User")}
              {proposal.createdAt
                ? ` · ${new Date(proposal.createdAt).toLocaleString()}`
                : ""}
            </p>
            <p className="text-sm">{proposal.reason}</p>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div>
                <h4 className="font-medium">Original</h4>
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {proposal.originalText || "Empty"}
                </pre>
              </div>
              <div>
                <h4 className="font-medium">Proposed</h4>
                <pre className="whitespace-pre-wrap break-words text-sm">
                  {proposal.proposedText || "Empty"}
                </pre>
              </div>
            </div>
            {replies.length > 0 && (
              <CommentEditorList
                comments={replies}
                readOnly
                onDeleteComment={() => {}}
                onUpdateComment={() => {}}
              />
            )}
          </article>
        );
      })}
    </section>
  );
}
