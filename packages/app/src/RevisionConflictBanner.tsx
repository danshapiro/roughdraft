import { useState } from "react";
import type { SyncConflict } from "@roughdraft/rfm";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./components/ui/dialog";
import type { RevisionConflictState, RevisionDraft } from "./revision-session";
import {
  conflictHeading,
  conflictValueText,
} from "./revision-conflict-presentation";
function VersionPair({ item }: { item: SyncConflict }) {
  return (
    <section className="min-w-0 space-y-2 rounded border p-3">
      <h3 className="font-medium">{conflictHeading(item)}</h3>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        {[
          ["My version", item.local],
          ["Latest version", item.incoming],
        ].map(([label, value]) => (
          <div key={String(label)} className="min-w-0">
            <h4 className="mb-1 text-sm font-medium">{String(label)}</h4>
            <pre
              data-testid="revision-compare-source"
              className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm"
            >
              {conflictValueText(value, item)}
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
}
export function RevisionConflictBanner({
  conflict,
  local,
  viewLabel,
  disabled,
  onResolve,
  onSaveSeparately,
  onRetry,
  onInspect,
  onReload,
  onRecover,
  onRecreate,
}: {
  conflict: RevisionConflictState;
  local: RevisionDraft;
  viewLabel?: string;
  disabled?: boolean;
  onResolve(choice: "local" | "incoming", signature: string): Promise<boolean>;
  onSaveSeparately(): void;
  onRetry(): Promise<unknown>;
  onInspect?(): void;
  onReload?(): Promise<boolean>;
  onRecover?(): Promise<boolean>;
  onRecreate?(expectedPath: string): Promise<boolean>;
}) {
  const [compare, setCompare] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    choice: "local" | "incoming";
    signature: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(false);
  const disk = conflict.state?.disk;
  const outsideFile =
    disk?.text != null &&
    (conflict.state?.review.targetChanged ||
      conflict.state?.review.liveSourceChanged ||
      disk.text !== conflict.state?.review.savedText);
  const [recreate, setRecreate] = useState<{
    path: string;
    signature: string;
  } | null>(null);
  const recreationPath =
    conflict.state?.canRecreateFile &&
    conflict.state.disk?.availability === "missing" &&
    conflict.state.disk.path === conflict.state.review.destinationPath
      ? conflict.state.review.destinationPath
      : null;
  const recreationChanged = Boolean(
    recreate &&
      (recreate.path !== recreationPath ||
        recreate.signature !== conflict.signature),
  );
  const conflicts = conflict.conflicts.length
    ? conflict.conflicts
    : [
        {
          id: "document",
          kind: "text" as const,
          base: "",
          local: local.markdown,
          incoming:
            (outsideFile ? disk?.text : conflict.state?.draft.markdown) ??
            "The latest version is temporarily unavailable.",
          label: "Working document",
        },
      ];
  const realConflict = conflict.kind === "conflict";
  const affected =
    conflict.state?.disk?.path ?? conflict.state?.review.title ?? "this review";
  async function resolve() {
    if (!confirmation) return;
    setBusy(true);
    setError("");
    try {
      if (await onResolve(confirmation.choice, confirmation.signature))
        setConfirmation(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section
        className="comparison-conflict space-y-3"
        data-testid="revision-conflict"
        aria-label="Review update needs attention"
      >
        <div>
          <strong>{conflict.message}</strong>
          <p className="mt-1 break-all text-sm">{affected}</p>
        </div>
        {realConflict && (
          <p>
            {conflict.conflicts.length} overlapping{" "}
            {conflict.conflicts.length === 1 ? "change" : "changes"}. Only
            overlapping changes are replaced; unrelated changes are kept.
          </p>
        )}
        {viewLabel && (
          <p className="text-sm">
            You are viewing {viewLabel}. These actions use your working draft.
          </p>
        )}
        <p className="text-sm" role="status">
          {conflict.checkpointSaved
            ? "Your changes are saved in a recovery copy."
            : "Your changes remain in this tab. Recovery has not synced yet."}
        </p>
        {conflict.storagePressure && (
          <p
            className="text-sm"
            role="status"
            data-testid="revision-recovery-storage-pressure"
          >
            Recovery storage is getting full. Your unique work is preserved.
            Download recovery copies or save separately before continuing.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {recreationPath && onRecreate && (
            <Button
              className="min-h-11"
              variant="outline"
              data-testid="revision-recreate-file"
              disabled={disabled || busy}
              onClick={() => {
                setError("");
                setRecreate({
                  path: recreationPath,
                  signature: conflict.signature,
                });
              }}
            >
              Recreate file
            </Button>
          )}
          {conflict.state?.publishing?.recoverable && onRecover && (
            <Button
              className="min-h-11"
              data-testid="revision-publication-recover"
              disabled={disabled || busy}
              title="Recover the saved review without rewriting the Markdown file"
              onClick={() => {
                setBusy(true);
                setError("");
                void onRecover()
                  .catch((caught) =>
                    setError(
                      caught instanceof Error ? caught.message : String(caught),
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Recover
            </Button>
          )}
          {realConflict && (
            <>
              <Button
                className="min-h-11"
                variant="outline"
                data-testid="revision-discard"
                disabled={disabled || busy}
                onClick={() => {
                  setError("");
                  setConfirmation({
                    choice: "incoming",
                    signature: conflict.signature,
                  });
                }}
              >
                Discard my changes
              </Button>
              <Button
                className="min-h-11"
                variant="outline"
                data-testid="revision-overwrite"
                disabled={disabled || busy}
                onClick={() => {
                  setError("");
                  setConfirmation({
                    choice: "local",
                    signature: conflict.signature,
                  });
                }}
              >
                Overwrite with my changes
              </Button>
            </>
          )}
          <Button
            className="min-h-11"
            variant="outline"
            data-testid="revision-save-separately"
            disabled={disabled || busy}
            onClick={onSaveSeparately}
          >
            Save separately
          </Button>
          <Button
            className="min-h-11"
            variant="ghost"
            data-testid="revision-compare-changes"
            onClick={() => setCompare(true)}
          >
            {realConflict ? "Compare changes" : "Compare latest"}
          </Button>
          {!realConflict && (
            <Button
              className="min-h-11"
              variant="outline"
              disabled={disabled || busy}
              onClick={() => {
                setError("");
                void onRetry().catch((caught) =>
                  setError(
                    caught instanceof Error ? caught.message : String(caught),
                  ),
                );
              }}
            >
              {conflict.kind === "indeterminate"
                ? "Retry save status"
                : "Retry update"}
            </Button>
          )}
          {onInspect && (
            <Button
              className="min-h-11"
              variant="ghost"
              data-testid="revision-inspect"
              onClick={onInspect}
            >
              Inspect file
            </Button>
          )}
          {conflict.reloadAvailable && onReload && (
            <Button
              className="min-h-11"
              variant="outline"
              disabled={disabled || busy}
              data-testid="revision-reload-file"
              onClick={() => setReload(true)}
            >
              Reload from file, keep feedback
            </Button>
          )}
        </div>
        {error && <p role="alert">{error}</p>}
      </section>
      <Dialog
        open={recreate !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRecreate(null);
        }}
      >
        <DialogContent data-testid="revision-recreate-dialog">
          <DialogTitle>Recreate the missing autosave file?</DialogTitle>
          <DialogDescription>
            Create this file from your current working draft. Pending
            suggestions, comments, History and unfinished feedback stay in this
            review. If the file appears first, Roughdraft stops without
            replacing it.
            {viewLabel
              ? ` You are viewing ${viewLabel}; this uses the working draft.`
              : ""}
          </DialogDescription>
          <p className="break-all rounded border p-3">{recreate?.path}</p>
          {recreationChanged && (
            <p role="alert">
              The file or its save destination changed. Close this dialog and
              inspect the latest update before continuing.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => setRecreate(null)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              data-testid="revision-recreate-confirm"
              disabled={
                disabled ||
                busy ||
                recreationChanged ||
                !recreate ||
                !onRecreate
              }
              onClick={() => {
                if (!recreate || !onRecreate || recreationChanged) return;
                setBusy(true);
                setError("");
                void onRecreate(recreate.path)
                  .then(
                    (done) => {
                      if (done) setRecreate(null);
                    },
                    (caught) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : String(caught),
                      ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Creating…" : "Recreate file"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={reload}
        onOpenChange={(open) => {
          if (!busy) setReload(open);
        }}
      >
        <DialogContent>
          <DialogTitle>Reload from file and keep feedback?</DialogTitle>
          <DialogDescription>
            The latest file becomes the working document. Comments and proposals
            that no longer match remain as detached or outdated feedback. A
            recovery copy preserves your current review.
          </DialogDescription>
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => setReload(false)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={busy || disabled}
              onClick={() => {
                setBusy(true);
                setError("");
                void onReload?.()
                  .then(
                    (done) => {
                      if (done) setReload(false);
                    },
                    (caught) =>
                      setError(
                        caught instanceof Error
                          ? caught.message
                          : String(caught),
                      ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Reload from file, keep feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={compare} onOpenChange={setCompare}>
        <DialogContent
          data-testid="revision-compare-dialog"
          className="max-w-4xl"
        >
          <DialogTitle>
            {realConflict
              ? "Compare overlapping changes"
              : "Compare latest saved review"}
          </DialogTitle>
          <DialogDescription>
            Inspect both versions without changing your working draft.
          </DialogDescription>
          <div className="min-w-0 space-y-3">
            {conflicts.map((item) => (
              <VersionPair key={item.id} item={item} />
            ))}
          </div>
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              onClick={() => setCompare(false)}
              data-testid="revision-compare-done"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <DialogContent
          data-testid="revision-resolve-dialog"
          className="max-w-4xl"
        >
          <DialogTitle>
            {confirmation?.choice === "local"
              ? "Overwrite overlapping changes?"
              : "Discard overlapping changes?"}
          </DialogTitle>
          <DialogDescription>
            Only overlapping changes are replaced; unrelated edits and comments
            from both versions are kept. This updates the working review
            {conflict.state?.review.destinationPath
              ? " and its autosave file"
              : " without writing a Markdown file"}
            .
            {viewLabel
              ? ` You are viewing ${viewLabel}; the working draft is affected.`
              : ""}
          </DialogDescription>
          <div className="space-y-3">
            {conflicts.map((item) => (
              <VersionPair key={item.id} item={item} />
            ))}
          </div>
          {confirmation && confirmation.signature !== conflict.signature && (
            <p role="alert">
              The overlapping changes changed. Close this dialog and inspect the
              latest comparison before confirming.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button
              className="min-h-11"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              data-testid="revision-resolve-confirm"
              disabled={
                busy ||
                disabled ||
                confirmation?.signature !== conflict.signature
              }
              onClick={() => void resolve()}
            >
              {busy
                ? "Saving…"
                : confirmation?.choice === "local"
                  ? "Overwrite overlapping changes"
                  : "Discard overlapping changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
