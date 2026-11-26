import { useState } from "react";
import type { SyncDraft } from "@roughdraft/rfm";
import { Button } from "./components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./components/ui/dialog";

export interface RecoverySnapshot {
  entryDraft: SyncDraft;
  workingDraft: SyncDraft;
  entryUiDrafts?: Record<string, unknown>;
  uiDrafts?: Record<string, unknown>;
  reason?: string;
}
export function RevisionRecoveryDialog({
  open,
  onOpenChange,
  copies,
  orphans,
  onInspect,
  onInspectOrphan,
  onRestore,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  copies: Array<{ id: string; reason: string }>;
  orphans: Array<{ key: string; aliveAt: number }>;
  onInspect(id: string): Promise<RecoverySnapshot>;
  onInspectOrphan(key: string): RecoverySnapshot;
  onRestore?(
    snapshot: RecoverySnapshot,
  ): Promise<{ restored: number; skipped: number }>;
}) {
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null);
  const [latest, setLatest] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const unfinished = latest ? snapshot?.uiDrafts : snapshot?.entryUiDrafts;
  const hasUnfinished = Boolean(
    unfinished &&
      (Object.keys(
        (unfinished.comments as Record<string, unknown> | undefined) ?? {},
      ).length ||
        unfinished.suggestion),
  );
  const selected = snapshot
    ? latest
      ? snapshot.workingDraft
      : snapshot.entryDraft
    : null;
  function download() {
    if (!snapshot) return;
    const href = URL.createObjectURL(
      new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = href;
    link.download = "roughdraft-recovery.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="revision-recovery-dialog"
        className="max-w-4xl"
      >
        <DialogTitle>Recovery copies</DialogTitle>
        <DialogDescription>
          Inspect preserved work without changing this review. Download includes
          the document, comments, decisions, History and unfinished feedback.
        </DialogDescription>
        <div className="space-y-2">
          {!copies.length && !orphans.length && (
            <p>No recovery copies are available.</p>
          )}
          {copies.map((copy) => (
            <Button
              key={copy.id}
              data-testid={`revision-recovery-copy-${copy.id}`}
              className="min-h-11 w-full justify-start whitespace-normal text-left"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                setNotice("");
                void onInspect(copy.id)
                  .then(
                    (value) => {
                      setSnapshot(value);
                      setLatest(true);
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
              {copy.reason}
            </Button>
          ))}
          {orphans.map((orphan) => (
            <Button
              key={orphan.key}
              data-testid={`revision-recovery-orphan-${orphan.key}`}
              className="min-h-11 w-full justify-start"
              variant="outline"
              onClick={() => {
                setError("");
                setNotice("");
                try {
                  setSnapshot(onInspectOrphan(orphan.key));
                  setLatest(true);
                } catch (caught) {
                  setError(
                    caught instanceof Error ? caught.message : String(caught),
                  );
                }
              }}
            >
              Recoverable browser work ·{" "}
              {new Date(orphan.aliveAt).toLocaleString()} (may still be open in
              another tab)
            </Button>
          ))}
        </div>
        {snapshot && selected && (
          <section className="min-w-0 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button
                className="min-h-11"
                data-testid="revision-recovery-initial"
                variant={latest ? "outline" : "default"}
                onClick={() => {
                  setLatest(false);
                  setNotice("");
                  setError("");
                }}
              >
                Initial copy
              </Button>
              <Button
                className="min-h-11"
                data-testid="revision-recovery-latest"
                variant={latest ? "default" : "outline"}
                onClick={() => {
                  setLatest(true);
                  setNotice("");
                  setError("");
                }}
              >
                Latest copy
              </Button>
            </div>
            <pre
              data-testid="revision-recovery-source"
              className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm"
            >
              {selected.markdown}
            </pre>
            <details>
              <summary className="min-h-11 cursor-pointer py-3">
                Complete feedback
              </summary>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                {JSON.stringify(
                  {
                    ...selected,
                    markdown: undefined,
                    unfinishedFeedback: unfinished,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {onRestore && hasUnfinished && (
              <Button
                className="min-h-11"
                variant="outline"
                data-testid="revision-recovery-restore-feedback"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  setNotice("");
                  void onRestore({
                    ...snapshot,
                    workingDraft: selected,
                    uiDrafts: unfinished,
                  })
                    .then(
                      (result) =>
                        setNotice(
                          result.restored
                            ? `Unfinished feedback restored.${result.skipped ? ` ${result.skipped} changed comments remain in the recovery copy.` : ""}`
                            : "These drafts no longer match this review. They remain in the recovery copy.",
                        ),
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
                Restore unfinished feedback
              </Button>
            )}
            <Button
              className="min-h-11"
              variant="outline"
              data-testid="revision-recovery-download"
              onClick={download}
            >
              Download complete recovery
            </Button>
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <DialogFooter>
          <Button
            className="min-h-11"
            data-testid="revision-recovery-done"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
