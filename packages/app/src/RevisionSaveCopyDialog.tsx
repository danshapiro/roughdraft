import type { CopyDestination, SyncResult } from "@roughdraft/rfm";
import { useEffect, useId, useRef, useState } from "react";
import { browserNavigationUrl } from "./browser-base-path";
import type { ComparisonReviewData } from "./comparison-types";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { copyRevisionMarkdown } from "./revision-markdown";

export function RevisionSaveCopyDialog({
  open,
  onOpenChange,
  inspect,
  save,
  unlock,
  checkStatus,
  onSavedResultShown,
  viewLabel,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  inspect(path?: string): Promise<CopyDestination>;
  save(
    path: string,
    acknowledged: boolean,
  ): Promise<SyncResult<ComparisonReviewData>>;
  unlock(): void;
  checkStatus(): Promise<SyncResult<ComparisonReviewData> | null>;
  onSavedResultShown?(result: SyncResult<ComparisonReviewData>): void;
  viewLabel?: string;
}) {
  const [path, setPath] = useState("");
  const [destination, setDestination] = useState<CopyDestination | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<
    "editing" | "saving" | "unknown" | "saved"
  >("editing");
  const [result, setResult] = useState<SyncResult<ComparisonReviewData> | null>(
    null,
  );
  const [error, setError] = useState("");
  const [composing, setComposing] = useState(false);
  const inspection = useRef(0);
  const pathEdits = useRef(0);
  const pathInputId = useId();
  const inspectionCallbacks = useRef({ checkStatus, inspect });
  inspectionCallbacks.current = { checkStatus, inspect };
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const pending = useRef(false);
  const receipt = useRef(onSavedResultShown);
  receipt.current = onSavedResultShown;
  const shownResult = useRef<SyncResult<ComparisonReviewData> | null>(null);
  const alive = useRef(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const editVersion = pathEdits.current;
    inspection.current++;
    void inspectionCallbacks.current
      .checkStatus()
      .then((saved) => {
        if (!active) return;
        if (saved?.status === "committed") {
          if (pending.current && currentStatus.current !== "unknown") return;
          setResult(saved);
          setStatus("saved");
          return;
        }
        if (
          pending.current ||
          currentStatus.current === "unknown" ||
          editVersion !== pathEdits.current
        )
          return;
        setStatus("editing");
        setResult(null);
        setError("");
        return inspectionCallbacks.current.inspect().then((next) => {
          if (
            active &&
            !pending.current &&
            currentStatus.current !== "unknown" &&
            editVersion === pathEdits.current
          ) {
            setPath(next.displayPath);
            setDestination(next);
            setAcknowledged(false);
          }
        });
      })
      .catch((caught) => {
        if (
          active &&
          !pending.current &&
          currentStatus.current !== "unknown" &&
          editVersion === pathEdits.current
        )
          setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
      inspection.current++;
    };
  }, [open]);
  useEffect(() => {
    if (!open || !path || status !== "editing" || composing) return;
    let active = true;
    const sequence = ++inspection.current;
    const timer = setTimeout(() => {
      void inspect(path)
        .then((next) => {
          if (active && sequence === inspection.current) setDestination(next);
        })
        .catch((caught) => {
          if (active && sequence === inspection.current)
            setError(caught instanceof Error ? caught.message : String(caught));
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [path, open, status, composing, inspect]);
  async function submit() {
    if (pending.current) return;
    if (composing) {
      setError(
        "Finish typing the path before saving. Cancel remains available.",
      );
      return;
    }
    pending.current = true;
    setStatus("saving");
    setError("");
    let publicationStarted = false;
    try {
      const inspected = await inspect(path);
      if (!alive.current) return;
      setDestination(inspected);
      if (!inspected.allowed) {
        setStatus("editing");
        setError(
          inspected.message ?? "Choose an unused writable Markdown path.",
        );
        return;
      }
      if (inspected.relativeLinks.length && !acknowledged) {
        setStatus("editing");
        setError(
          "Acknowledge the relative links before saving into this folder.",
        );
        return;
      }
      publicationStarted = true;
      saveTimer.current = setTimeout(() => {
        if (alive.current && pending.current) {
          setStatus("unknown");
          unlock();
        }
      }, 10_000);
      const saved = await save(path, acknowledged);
      if (!alive.current) return;
      if (saved.status === "committed") {
        setResult(saved);
        setStatus("saved");
      } else if (
        saved.status === "publishing" ||
        saved.status === "indeterminate"
      ) {
        setStatus("unknown");
        setError(
          saved.message ??
            "The copy may still be saving. Check its status before retrying.",
        );
      } else {
        setStatus("editing");
        setError(
          saved.message ??
            "The copy was not saved. Inspect the path and retry.",
        );
      }
    } catch (caught) {
      if (alive.current) {
        setStatus(publicationStarted ? "unknown" : "editing");
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      pending.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      unlock();
    }
  }
  async function retryStatus() {
    setError("");
    try {
      const saved = await checkStatus();
      if (saved?.status === "committed") {
        setResult(saved);
        setStatus("saved");
      } else if (saved && ["not-received", "rejected"].includes(saved.status))
        setStatus("editing");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  const savedPath =
    result?.savedPath ?? result?.state?.review.destinationPath ?? path;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl"
        data-testid="revision-save-copy-dialog"
      >
        <DialogTitle>
          {status === "saved" ? "Saved separately" : "Save a separate copy"}
        </DialogTitle>
        <DialogDescription>
          Saves your working document. Comments, suggestions and History remain
          available in the new Roughdraft review.
          {viewLabel
            ? ` You are viewing ${viewLabel}; this saves the working draft, not this preview.`
            : ""}
        </DialogDescription>
        {status === "saved" ? (
          <>
            <p role="status">Your copy was saved at:</p>
            <code
              ref={(element) => {
                if (
                  element &&
                  open &&
                  result &&
                  shownResult.current !== result
                ) {
                  shownResult.current = result;
                  receipt.current?.(result);
                }
              }}
              className="overflow-auto whitespace-pre-wrap break-all rounded border p-3"
              data-testid="revision-copy-saved-path"
            >
              {savedPath}
            </code>
            <DialogFooter>
              <Button
                className="min-h-11"
                variant="outline"
                data-testid="revision-copy-path-to-clipboard"
                onClick={() =>
                  void copyRevisionMarkdown(savedPath).catch((caught) =>
                    setError(String(caught)),
                  )
                }
              >
                Copy path
              </Button>
              {result?.reviewUrl && (
                <Button
                  className="min-h-11"
                  variant="outline"
                  render={
                    <a
                      aria-label="Open saved review"
                      href={browserNavigationUrl(result.reviewUrl)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open saved review
                    </a>
                  }
                >
                  Open saved review
                </Button>
              )}
              <Button
                className="min-h-11"
                data-testid="revision-copy-done"
                onClick={() => onOpenChange(false)}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <label className="space-y-2" htmlFor={pathInputId}>
              <span className="text-sm font-medium">
                File path on{" "}
                {destination?.installationName === "this server"
                  ? window.location.hostname
                  : (destination?.installationName ?? "this server")}
              </span>
              <Input
                id={pathInputId}
                className="min-h-11 text-base"
                data-testid="revision-copy-path"
                value={path}
                disabled={status === "saving"}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onChange={(event) => {
                  pathEdits.current++;
                  inspection.current++;
                  setPath(event.target.value);
                  setDestination(null);
                  setAcknowledged(false);
                  setError("");
                }}
              />
            </label>
            {destination?.relativeLinks.length ? (
              <div className="space-y-2 rounded border p-3 text-sm">
                <p>
                  These {destination.relativeLinks.length} relative links may
                  resolve differently in this folder. The document will not be
                  rewritten.
                </p>
                <ul className="max-h-28 overflow-auto break-all">
                  {destination.relativeLinks.map((link) => (
                    <li key={link}>{link}</li>
                  ))}
                </ul>
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                  />
                  Save here with these relative links
                </label>
              </div>
            ) : null}
            {destination && !destination.allowed && (
              <p role="status">{destination.message}</p>
            )}
            {status === "unknown" && (
              <p role="status">
                Save status unknown. Your editor is unlocked on the original
                review. Newer edits stay there; a late result will not switch
                them into this copy.
              </p>
            )}
            <DialogFooter>
              <Button
                className="min-h-11"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {status === "saving" || status === "unknown"
                  ? "Close"
                  : "Cancel"}
              </Button>
              {status === "unknown" ? (
                <Button className="min-h-11" onClick={() => void retryStatus()}>
                  Retry save status
                </Button>
              ) : (
                <Button
                  className="min-h-11"
                  data-testid="revision-save-copy-confirm"
                  disabled={
                    status === "saving" ||
                    !path ||
                    !destination?.allowed ||
                    Boolean(destination.relativeLinks.length && !acknowledged)
                  }
                  onClick={() =>
                    void submit().catch((caught) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : String(caught),
                      ),
                    )
                  }
                >
                  {status === "saving" ? "Saving…" : "Save copy"}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
