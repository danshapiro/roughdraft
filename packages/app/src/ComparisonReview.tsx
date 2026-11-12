import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiBackend } from "./api-backend";
import { buildLocationForLinkedMarkdownDocument } from "./app-navigation";
import { buildComparisonDocument } from "./comparison-document";
import type {
  ComparisonReviewData as Comparison,
  ComparisonReviewComment,
  ComparisonDecision as Decision,
} from "./comparison-types";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import type { ControlledDocumentReview } from "./controlled-review";
import { RichTextEditorSurface } from "./PageCard";
import "./ComparisonReview.css";

type Choices = {
  decisions?: { id: string; decision?: Decision; comment?: string }[];
  comment?: string;
  reviewComments?: ComparisonReviewComment[];
};

class ComparisonError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function requestComparison(id: string, action?: string, body?: unknown) {
  const response = await fetch(
    `/api/comparisons/${encodeURIComponent(id)}${action ? `/${action}` : ""}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new ComparisonError(
      result.error ?? "The review could not be saved.",
      response.status,
    );
  }
  return result as Comparison;
}

function applyLocalChoices(review: Comparison, choices: Choices): Comparison {
  return {
    ...review,
    ...(choices.comment !== undefined ? { comment: choices.comment } : {}),
    ...(choices.reviewComments !== undefined
      ? { reviewComments: choices.reviewComments }
      : {}),
    segments: review.segments.map((segment) => {
      const choice = choices.decisions?.find((item) => item.id === segment.id);
      return choice ? { ...segment, ...choice } : segment;
    }),
  };
}

function NativeComparisonDocument({
  review,
  showReviewed,
  busy,
  onChoices,
}: {
  review: Comparison;
  showReviewed: boolean;
  busy: boolean;
  onChoices: (choices: Choices) => void;
}) {
  const contextPath =
    review.targetPath ??
    [review.afterLabel, review.beforeLabel].find((label) =>
      label.startsWith("/"),
    ) ??
    null;
  const backend = useMemo(
    () =>
      new ApiBackend({
        kind: "local-files",
        label: "Markdown comparison",
        detail: contextPath ?? "Frozen versions",
        projectPath: contextPath
          ? contextPath.slice(0, contextPath.lastIndexOf("/")) || "/"
          : undefined,
      }),
    [contextPath],
  );
  const model = useMemo(
    () =>
      buildComparisonDocument(review, {
        showReviewed,
        resolveFileUrl: (path) => backend.resolveFileUrl(path),
        resolveLinkUrl: (href) =>
          buildLocationForLinkedMarkdownDocument({
            projectPath: backend.info.projectPath,
            currentDocumentPath: contextPath,
            href,
          }),
      }),
    [review, showReviewed, backend, contextPath],
  );
  const commentsRef = useRef(review.reviewComments ?? []);
  commentsRef.current = review.reviewComments ?? [];
  const legacyCommentSegment = (commentId: string) =>
    review.segments.find(
      (segment) =>
        segment.kind === "change" && `legacy:${segment.id}` === commentId,
    );
  const decide = (groupId: string, decision: Decision) => {
    const group = model.groups.find((item) => item.id === groupId);
    if (!group) return;
    onChoices({ decisions: group.segmentIds.map((id) => ({ id, decision })) });
  };
  const updateComments = (comments: ComparisonReviewComment[]) => {
    commentsRef.current = comments;
    onChoices({ reviewComments: comments });
  };
  const createComment = (groupId: string | null, parentCommentId: string) => {
    const group = model.groups.find(
      (item) => item.id === groupId || item.segmentIds.includes(groupId ?? ""),
    );
    const parent = commentsRef.current.find(
      (comment) => comment.id === parentCommentId,
    );
    const legacy = legacyCommentSegment(parentCommentId);
    const changeId = group?.segmentIds[0] ?? parent?.changeId ?? legacy?.id;
    if (!changeId) return null;
    const id = `review-${crypto.randomUUID()}`;
    updateComments([
      ...commentsRef.current,
      {
        id,
        changeId,
        content: "",
        createdAt: new Date().toISOString(),
        authorType: "user",
        parentCommentId: parentCommentId || groupId,
      },
    ]);
    return id;
  };
  const updateComment = (commentId: string, content: string) => {
    const legacy = legacyCommentSegment(commentId);
    if (legacy) onChoices({ decisions: [{ id: legacy.id, comment: content }] });
    else
      updateComments(
        commentsRef.current.map((comment) =>
          comment.id === commentId ? { ...comment, content } : comment,
        ),
      );
  };
  const deleteComment = (commentId: string) => {
    const removed = new Set([commentId]);
    for (let previous = -1; previous !== removed.size; ) {
      previous = removed.size;
      for (const comment of commentsRef.current)
        if (comment.parentCommentId && removed.has(comment.parentCommentId))
          removed.add(comment.id);
    }
    const nextComments = commentsRef.current.filter(
      (comment) => !removed.has(comment.id),
    );
    commentsRef.current = nextComments;
    const legacy = legacyCommentSegment(commentId);
    onChoices({
      reviewComments: nextComments,
      ...(legacy ? { decisions: [{ id: legacy.id, comment: "" }] } : {}),
    });
  };
  const controlledReview: ControlledDocumentReview = {
    ...model,
    canDecide: review.mode !== "compare" && review.status === "open",
    disabled: busy || review.status !== "open",
    acceptLabel: review.mode === "applied" ? "Keep" : "Accept",
    rejectLabel: review.mode === "applied" ? "Revert" : "Skip",
    onAccept: (id) => decide(id, "after"),
    onReject: (id) => decide(id, "before"),
    onCreateComment: createComment,
    onUpdateComment: updateComment,
    onDeleteComment: deleteComment,
  };
  const linkedGroups = model.groups.filter(
    (group) => group.segmentIds.length > 1,
  );
  return (
    <>
      {linkedGroups.length > 0 && (
        <p
          className="comparison-linked-notice"
          data-testid="comparison-linked-notice"
        >
          {
            review.segments.filter((segment) => segment.kind === "change")
              .length
          }{" "}
          source changes appear in {model.groups.length} review{" "}
          {model.groups.length === 1 ? "group" : "groups"}. Changes within one
          Markdown block are reviewed together; each card shows its linked
          count. Existing individual choices remain saved until you choose
          again.
        </p>
      )}
      <div
        className="comparison-native-document"
        data-testid="comparison-native-document"
      >
        <RichTextEditorSurface
          page={{
            id: review.id,
            title: review.title,
            content: review.afterText,
          }}
          activeDocumentPath={contextPath}
          selected={true}
          layout="default"
          focusRequestKey={null}
          sourceMarkdown={review.afterText}
          onMarkdownChange={() => {}}
          interactionMode="viewing"
          backend={backend}
          controlledReview={controlledReview}
        />
      </div>
    </>
  );
}

export function ComparisonReview({ id }: { id: string }) {
  const [review, setReview] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const [busy, setBusy] = useState(false);
  const [convertVisible, setConvertVisible] = useState(false);
  const [destination, setDestination] = useState("");
  const [refreshNotice, setRefreshNotice] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const savedRef = useRef<Comparison | null>(null);
  const queueRef = useRef<Choices[]>([]);
  const savingRef = useRef(false);
  const failedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    requestComparison(id)
      .then((next) => {
        if (!mountedRef.current) return;
        savedRef.current = next;
        setReview(next);
        setError(null);
      })
      .catch((reason: Error) => {
        if (mountedRef.current) setError(reason.message);
      });
    return () => {
      mountedRef.current = false;
    };
  }, [id]);

  const drain = useCallback(async () => {
    if (savingRef.current || failedRef.current || !savedRef.current) return;
    savingRef.current = true;
    setSaveState("saving");
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current[0];
        const saved = await requestComparison(id, "decisions", {
          revision: savedRef.current.revision,
          ...next,
        });
        savedRef.current = saved;
        queueRef.current.shift();
        if (mountedRef.current) {
          setReview(queueRef.current.reduce(applyLocalChoices, saved));
        }
      }
      if (mountedRef.current) setSaveState("saved");
    } catch (reason) {
      failedRef.current = true;
      if (mountedRef.current) {
        setSaveState("failed");
        setError(
          reason instanceof Error
            ? reason.message
            : "Review save failed. Your choices remain on this page.",
        );
      }
    } finally {
      savingRef.current = false;
    }
  }, [id]);

  const changeChoices = (choices: Choices) => {
    setReview((current) =>
      current ? applyLocalChoices(current, choices) : current,
    );
    queueRef.current.push(choices);
    void drain();
  };

  // Only the destination-change flag is refreshed automatically. Versions and
  // selections stay frozen until an explicit refresh or successful mutation.
  const pollDestination =
    review?.status === "open" && Boolean(review.targetPath);
  useEffect(() => {
    if (!pollDestination) return;
    const timer = window.setInterval(() => {
      requestComparison(id)
        .then((next) => {
          if (mountedRef.current)
            setReview((current) =>
              current
                ? { ...current, targetChanged: next.targetChanged }
                : current,
            );
        })
        .catch(() => {
          /* The next explicit save reports connectivity failures. */
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [id, pollDestination]);

  const retryChoices = async () => {
    setBusy(true);
    try {
      savedRef.current = await requestComparison(id);
      failedRef.current = false;
      setError(null);
      await drain();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not reconnect.",
      );
    } finally {
      setBusy(false);
    }
  };

  const finish = async (
    action: "apply" | "complete" | "refresh" | "convert",
  ) => {
    if (!savedRef.current || queueRef.current.length || savingRef.current)
      return;
    setBusy(true);
    setError(null);
    try {
      const next = await requestComparison(id, action, {
        revision: savedRef.current.revision,
        ...(action === "convert" ? { targetPath: destination } : {}),
      });
      if (action === "convert") {
        window.location.assign(`/?comparison=${encodeURIComponent(next.id)}`);
        return;
      }
      savedRef.current = next;
      setReview(next);
      if (action === "refresh") setRefreshNotice(true);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The review could not be finished.",
      );
      try {
        const current = await requestComparison(id);
        setReview((previous) =>
          previous
            ? { ...previous, targetChanged: current.targetChanged }
            : previous,
        );
      } catch {
        /* Preserve the visible choices while the server is unavailable. */
      }
    } finally {
      setBusy(false);
    }
  };

  if (!review)
    return (
      <main className="comparison-page" data-testid="comparison-page">
        <p role={error ? "alert" : "status"}>
          {error ?? "Loading comparison…"}
        </p>
      </main>
    );
  const changes = review.segments.filter(
    (segment) => segment.kind === "change",
  );
  const pending = changes.filter(
    (segment) => segment.decision === "pending",
  ).length;
  const selected = changes.filter(
    (segment) =>
      segment.decision === (review.mode === "applied" ? "before" : "after"),
  ).length;
  const writable = review.mode !== "compare";
  const open = review.status === "open";
  const disabled = busy || saveState !== "saved";
  const basename = review.targetPath?.split(/[\\/]/).at(-1) ?? "file";
  const modeLabel =
    review.mode === "proposal"
      ? "Proposed changes"
      : review.mode === "applied"
        ? "Changes already made"
        : "Compare two versions";
  const chooseAll = (decision: Decision) =>
    changeChoices({
      decisions: changes.map(({ id: segmentId }) => ({
        id: segmentId,
        decision,
      })),
    });

  return (
    <main className="comparison-page" data-testid="comparison-page">
      <header className="comparison-header">
        <a href="/" className="comparison-brand">
          Roughdraft <span>Changes</span>
        </a>
        <span className="comparison-mode" data-testid="comparison-mode">
          {modeLabel}
        </span>
        <h1>{review.title || basename}</h1>
        {review.targetPath ? (
          <p className="comparison-target" data-testid="comparison-target">
            File: <code>{review.targetPath}</code>
          </p>
        ) : (
          <p className="comparison-target">
            No destination file. This comparison cannot write to either version.
          </p>
        )}
        <p
          className="comparison-explanation"
          data-testid="comparison-explanation"
        >
          {!open
            ? review.completion?.fileWritten
              ? "Your selected changes were saved to the destination file."
              : "This review finished without writing a file."
            : review.mode === "proposal"
              ? "The file is unchanged. Accept or Skip each change, then Apply to write your selection."
              : review.mode === "applied"
                ? "These changes are already in the file. Keep or Revert each change, then save the selected reversions."
                : "These are frozen versions for discussion. To apply changes, first choose a destination with Propose these edits."}{" "}
          Choices and comments save separately from the file.
        </p>
      </header>

      {error && (
        <div
          className="comparison-error"
          role="alert"
          data-testid="comparison-error"
        >
          <p>{error}</p>
          {saveState === "failed" && (
            <>
              <p>Your unsaved choices remain on this page.</p>
              <Button
                variant="outline"
                data-testid="comparison-retry"
                disabled={busy}
                onClick={() => void retryChoices()}
              >
                Retry saving these choices
              </Button>
            </>
          )}
          <p>Reloading replaces this page’s choices with the saved review.</p>
          <Button
            variant="outline"
            data-testid="comparison-reload"
            disabled={busy}
            onClick={() => window.location.reload()}
          >
            Reload saved review
          </Button>
        </div>
      )}
      {review.targetChanged && open && (
        <div
          className="comparison-conflict"
          role="alert"
          data-testid="comparison-conflict"
        >
          <p>
            The destination changed after this comparison was created. Your
            choices are preserved. Applying is blocked.
          </p>
          <p>
            Refresh compares with the current file. Choices survive only where
            the exact change is unchanged; review the remaining changes again.
          </p>
          <Button
            variant="outline"
            data-testid="comparison-refresh"
            disabled={disabled}
            onClick={() => void finish("refresh")}
          >
            Refresh comparison
          </Button>
        </div>
      )}
      {refreshNotice && (
        <p
          className="comparison-notice"
          data-testid="comparison-refresh-notice"
        >
          Comparison refreshed from the current file. Review undecided changes
          again before applying.
        </p>
      )}
      {!open && (
        <div
          className="comparison-outcome"
          role="status"
          data-testid="comparison-outcome"
        >
          {review.completion?.fileWritten ? (
            <>
              Saved your selected changes to{" "}
              <code>{review.completion.targetPath}</code>.
            </>
          ) : (
            <>Review finished. No file was written.</>
          )}{" "}
          <span>Review choices and comments are retained.</span>
        </div>
      )}

      <div className="comparison-toolbar" data-testid="comparison-toolbar">
        <p>
          {changes.length} {changes.length === 1 ? "change" : "changes"}
          {writable && open ? ` · ${pending} undecided` : ""}
        </p>
        {writable && open && (
          <div className="comparison-batch">
            <Button
              variant="outline"
              size="sm"
              data-testid="comparison-accept-all"
              disabled={busy}
              onClick={() => chooseAll("after")}
            >
              {review.mode === "applied" ? "Keep all" : "Accept all"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="comparison-skip-all"
              disabled={busy}
              onClick={() => chooseAll("before")}
            >
              {review.mode === "applied" ? "Revert all" : "Skip all"}
            </Button>
          </div>
        )}
        <span
          className={`comparison-save comparison-save-${saveState}`}
          role="status"
          data-testid="comparison-save-status"
        >
          {saveState === "saving"
            ? "Saving review…"
            : saveState === "failed"
              ? "Review not saved"
              : "Review saved separately"}
        </span>
      </div>
      <div className="comparison-version-labels">
        <span>Before: {review.beforeLabel}</span>
        <span>After: {review.afterLabel}</span>
      </div>
      <Button
        variant="outline"
        size="sm"
        data-testid="comparison-show-reviewed"
        aria-pressed={showReviewed}
        onClick={() => setShowReviewed(!showReviewed)}
      >
        {showReviewed ? "Hide reviewed changes" : "Show reviewed changes"}
      </Button>
      {changes.length === 0 && (
        <p className="comparison-empty" data-testid="comparison-identical">
          The versions are identical. There are no changes to apply.
        </p>
      )}
      <NativeComparisonDocument
        review={review}
        showReviewed={showReviewed}
        busy={busy}
        onChoices={changeChoices}
      />
      <label
        className="comparison-overall-comment"
        htmlFor="comparison-overall-feedback"
      >
        <span>Overall feedback</span>
        <Textarea
          id="comparison-overall-feedback"
          data-testid="comparison-comment"
          value={review.comment}
          placeholder="Optional feedback for the agent"
          disabled={!open || busy}
          onChange={(event) => changeChoices({ comment: event.target.value })}
        />
      </label>
      {open && (
        <footer className="comparison-actions">
          <p>
            {writable
              ? pending > 0
                ? `Choose ${review.mode === "applied" ? "Keep or Revert" : "Accept or Skip"} for all ${pending} undecided ${pending === 1 ? "change" : "changes"} before saving the file.`
                : selected > 0
                  ? `${selected} selected ${selected === 1 ? "change will" : "changes will"} be written to ${basename}.`
                  : "Your selection keeps the file as it is. No content changes will be written."
              : "Finishing this comparison does not write to either version."}
          </p>
          <div className="comparison-final-buttons">
            <Button
              variant="outline"
              data-testid="comparison-complete"
              disabled={disabled}
              onClick={() => void finish("complete")}
            >
              {writable ? "Finish without applying" : "Finish comparison"}
            </Button>
            {writable ? (
              <Button
                data-testid="comparison-apply"
                disabled={
                  disabled ||
                  pending > 0 ||
                  review.targetChanged ||
                  changes.length === 0
                }
                onClick={() => void finish("apply")}
              >
                {review.mode === "applied"
                  ? `Revert ${selected} ${selected === 1 ? "change" : "changes"} in ${basename}`
                  : `Apply ${selected} ${selected === 1 ? "change" : "changes"} to ${basename}`}
              </Button>
            ) : (
              <Button
                data-testid="comparison-propose"
                disabled={disabled}
                onClick={() => setConvertVisible(true)}
              >
                Propose these edits
              </Button>
            )}
          </div>
          {convertVisible && !writable && (
            <div
              className="comparison-convert"
              data-testid="comparison-convert"
            >
              <label htmlFor="comparison-destination">
                Destination file (must currently match Before)
              </label>
              <Input
                id="comparison-destination"
                data-testid="comparison-convert-target"
                placeholder="/absolute/path/to/AGENTS.md"
                value={destination}
                disabled={disabled}
                onChange={(event) => setDestination(event.target.value)}
              />
              <p>
                This creates a new proposal. It does not write the file; Accept
                / Skip and Apply happen in the next review.
              </p>
              <Button
                data-testid="comparison-convert-submit"
                disabled={disabled || !destination.trim()}
                onClick={() => void finish("convert")}
              >
                Create proposal for this file
              </Button>
            </div>
          )}
        </footer>
      )}
    </main>
  );
}
