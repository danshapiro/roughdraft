import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import "./ComparisonReview.css";

type Decision = "pending" | "before" | "after";
type Segment = {
  id: string;
  kind: "equal" | "change";
  before: string;
  after: string;
  oldStart: number;
  newStart: number;
  decision: Decision;
  comment: string;
};
type Comparison = {
  id: string;
  revision: number;
  mode: "proposal" | "applied" | "compare";
  title: string;
  beforeLabel: string;
  afterLabel: string;
  targetPath: string | null;
  segments: Segment[];
  comment: string;
  status: "open" | "completed" | "applied";
  targetChanged: boolean;
  completion: {
    fileWritten: boolean;
    targetPath: string | null;
    accepted: number;
    reverted: number;
    completedAt: string;
  } | null;
};
type Choices = {
  decisions?: { id: string; decision?: Decision; comment?: string }[];
  comment?: string;
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
    segments: review.segments.map((segment) => {
      const choice = choices.decisions?.find((item) => item.id === segment.id);
      return choice ? { ...segment, ...choice } : segment;
    }),
  };
}

function sourceLines(text: string) {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function SourceRows({
  text,
  oldStart,
  newStart,
  kind,
}: {
  text: string;
  oldStart: number | null;
  newStart: number | null;
  kind: "equal" | "removed" | "added";
}) {
  const rows = sourceLines(text).map((line, offset, lines) => ({
    text: line.endsWith("\r") ? line.slice(0, -1) : line,
    oldLine: oldStart === null ? null : oldStart + offset,
    newLine: newStart === null ? null : newStart + offset,
    noNewline: offset === lines.length - 1 && !text.endsWith("\n"),
  }));
  return rows.map((row) => (
    <div
      className={`comparison-line comparison-line-${kind}`}
      key={`${kind}:${row.oldLine}:${row.newLine}`}
    >
      <span className="comparison-line-number" aria-hidden="true">
        {row.oldLine}
      </span>
      <span className="comparison-line-number" aria-hidden="true">
        {row.newLine}
      </span>
      <span className="comparison-line-sign" aria-hidden="true">
        {kind === "added" ? "+" : kind === "removed" ? "−" : " "}
      </span>
      <code>
        {kind !== "equal" && (
          <span className="sr-only">
            {kind === "added" ? "Added: " : "Removed: "}
          </span>
        )}
        {row.text}
        {row.noNewline && (
          <span className="comparison-no-newline"> ⏎ No newline at end</span>
        )}
      </code>
    </div>
  ));
}

function EqualContext({ segment }: { segment: Segment }) {
  const [expanded, setExpanded] = useState(false);
  const lines = sourceLines(segment.before);
  if (lines.length <= 8 || expanded) {
    return (
      <SourceRows
        text={segment.before}
        oldStart={segment.oldStart}
        newStart={segment.newStart}
        kind="equal"
      />
    );
  }
  const first = `${lines.slice(0, 3).join("\n")}\n`;
  const last =
    lines.slice(-3).join("\n") + (segment.before.endsWith("\n") ? "\n" : "");
  return (
    <>
      <SourceRows
        text={first}
        oldStart={segment.oldStart}
        newStart={segment.newStart}
        kind="equal"
      />
      <Button
        variant="ghost"
        size="sm"
        className="comparison-expand"
        data-testid="comparison-expand-context"
        onClick={() => setExpanded(true)}
      >
        Show {lines.length - 6} unchanged lines
      </Button>
      <SourceRows
        text={last}
        oldStart={segment.oldStart + lines.length - 3}
        newStart={segment.newStart + lines.length - 3}
        kind="equal"
      />
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

      <div className="comparison-toolbar">
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
      <section
        className="comparison-diff"
        data-testid="comparison-diff"
        aria-label="Markdown source changes"
      >
        <div className="comparison-version-labels">
          <span>− Before: {review.beforeLabel}</span>
          <span>+ After: {review.afterLabel}</span>
        </div>
        {changes.length === 0 && (
          <p className="comparison-empty" data-testid="comparison-identical">
            The versions are identical. There are no changes to apply.
          </p>
        )}
        {review.segments.map((segment) =>
          segment.kind === "equal" ? (
            <div className="comparison-context" key={segment.id}>
              <EqualContext segment={segment} />
            </div>
          ) : (
            <section
              key={segment.id}
              className={`comparison-change comparison-decision-${segment.decision}`}
              data-testid="comparison-change"
            >
              <div className="comparison-change-heading">
                <span>
                  Lines {segment.oldStart} → {segment.newStart}
                </span>
                {writable && (
                  <div className="comparison-choice-buttons">
                    <Button
                      size="sm"
                      variant={
                        segment.decision === "after" ? "default" : "outline"
                      }
                      data-testid="comparison-choice-after"
                      aria-pressed={segment.decision === "after"}
                      disabled={!open || busy}
                      onClick={() =>
                        changeChoices({
                          decisions: [{ id: segment.id, decision: "after" }],
                        })
                      }
                    >
                      {review.mode === "applied" ? "Keep" : "Accept"}
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        segment.decision === "before" ? "default" : "outline"
                      }
                      data-testid="comparison-choice-before"
                      aria-pressed={segment.decision === "before"}
                      disabled={!open || busy}
                      onClick={() =>
                        changeChoices({
                          decisions: [{ id: segment.id, decision: "before" }],
                        })
                      }
                    >
                      {review.mode === "applied" ? "Revert" : "Skip"}
                    </Button>
                  </div>
                )}
              </div>
              <SourceRows
                text={segment.before}
                oldStart={segment.oldStart}
                newStart={null}
                kind="removed"
              />
              <SourceRows
                text={segment.after}
                oldStart={null}
                newStart={segment.newStart}
                kind="added"
              />
              <label
                className="comparison-comment"
                htmlFor={`comparison-comment-${segment.id}`}
              >
                <span>Comment on this change</span>
                <Textarea
                  id={`comparison-comment-${segment.id}`}
                  data-testid="comparison-change-comment"
                  aria-label={`Comment on change at line ${segment.oldStart}`}
                  placeholder="Optional feedback for the agent"
                  value={segment.comment}
                  disabled={!open || busy}
                  onChange={(event) =>
                    changeChoices({
                      decisions: [
                        { id: segment.id, comment: event.target.value },
                      ],
                    })
                  }
                />
              </label>
            </section>
          ),
        )}
      </section>
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
