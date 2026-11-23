import { useCallback, useEffect, useRef, useState } from "react";
import { browserPath } from "./browser-base-path";
import type {
  ComparisonReviewComment,
  ComparisonReviewData,
  EditorDraft,
} from "./comparison-types";
import { equalRevisionDraft as equalDraft } from "./revision-draft";
import { cleanRevisionMarkdown } from "./revision-markdown";

class RevisionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function revisionRequest<T>(path: string, body?: object): Promise<T> {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(
    browserPath(`/api/comparisons${path}`),
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: serialized,
          // Small pending reviews can finish syncing when the tab closes.
          // Larger drafts retain normal fetch and browser recovery; keepalive
          // has a browser-wide quota of 64 KiB for outstanding request bodies.
          keepalive:
            document.visibilityState === "hidden" &&
            new TextEncoder().encode(serialized).byteLength <= 60 * 1024,
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new RevisionRequestError(
      data.error ?? "Roughdraft could not complete that action.",
      response.status,
    );
  return data;
}

export interface InspectedDestination {
  path: string;
  version: string | null;
  markdown: string | null;
}

export interface RevisionDraft extends EditorDraft {
  reviewComments: ComparisonReviewComment[];
}

function storedDraft(review: ComparisonReviewData): RevisionDraft | null {
  return review.draft
    ? { ...review.draft, reviewComments: review.reviewComments ?? [] }
    : null;
}

function needsFileSave(
  review: ComparisonReviewData,
  draft: RevisionDraft,
  paused: boolean,
) {
  return (
    !paused &&
    Boolean(review.destinationPath) &&
    (draft.cleanMarkdown ?? draft.markdown) !==
      cleanRevisionMarkdown(review.savedText ?? "")
  );
}

interface BrowserRecovery {
  revision: number;
  draft: RevisionDraft;
  inFlight?: { draft: RevisionDraft; selectsBase: boolean } | null;
  stale?: boolean;
  baseVersion?: ComparisonReviewData["baseVersion"];
}

function restoreBrowserDraft(initial: ComparisonReviewData, key: string) {
  const persisted = storedDraft(initial);
  for (const tabOnly of [true, false]) {
    try {
      const storage = tabOnly ? sessionStorage : localStorage;
      const browser = JSON.parse(
        storage.getItem(key) ?? "null",
      ) as BrowserRecovery | null;
      if (
        !browser ||
        typeof browser.draft?.markdown !== "string" ||
        !browser.draft.decisions ||
        !Array.isArray(browser.draft.reviewComments) ||
        equalDraft(browser.draft, persisted)
      )
        continue;
      if (
        browser.revision + 1 === initial.revision &&
        browser.inFlight &&
        equalDraft(browser.inFlight.draft, persisted)
      ) {
        // The completed base selection is a different document projection.
        if (browser.inFlight.selectsBase) return null;
        return {
          draft: browser.draft,
          stale: false,
          baseVersion: browser.baseVersion,
        };
      }
      if (browser.revision === initial.revision && !browser.stale)
        return {
          draft: browser.draft,
          stale: false,
          baseVersion: browser.baseVersion,
        };
      // A second tab may have committed this review. Keep only this tab's
      // unsaved work, and require an explicit copy before writing again.
      if (tabOnly)
        return {
          draft: browser.draft,
          stale: true,
          baseVersion: browser.baseVersion,
        };
    } catch {
      // The storage API may be disabled or have invalid/old records.
    }
  }
  return null;
}

export function useRevisionSession(
  initial: ComparisonReviewData,
  seed: RevisionDraft,
) {
  const [browser] = useState(() =>
    restoreBrowserDraft(initial, `roughdraft-draft:${initial.id}`),
  );
  const [session, setSession] = useState(() =>
    browser?.stale && browser.baseVersion !== undefined
      ? { ...initial, baseVersion: browser.baseVersion }
      : initial,
  );
  const server = useRef(initial);
  const storageIdentity = useRef({
    id: initial.id,
    baseVersion: session.baseVersion ?? null,
  });
  const [draft, setDraft] = useState(
    () => browser?.draft ?? storedDraft(initial) ?? seed,
  );
  const latest = useRef(draft);
  const mounted = useRef(false);
  const queue = useRef(Promise.resolve());
  const inFlight = useRef<BrowserRecovery["inFlight"]>(null);
  const lastLocalRecord = useRef<string | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [reviewChanged, setReviewChanged] = useState(Boolean(browser?.stale));
  const stale = useRef(Boolean(browser?.stale));
  const [writePaused, setWritePaused] = useState(
    initial.targetChanged || stale.current,
  );
  const paused = useRef(initial.targetChanged || stale.current);
  const storeLocally = useCallback(() => {
    const current = server.current;
    const previousKey = `roughdraft-draft:${storageIdentity.current.id}`;
    if (storageIdentity.current.id !== current.id) {
      // A fork gets its own recovery slot, even if typing continued in flight.
      try {
        sessionStorage.removeItem(previousKey);
        if (localStorage.getItem(previousKey) === lastLocalRecord.current)
          localStorage.removeItem(previousKey);
      } catch {
        // Recovery still works through the new sidecar.
      }
      lastLocalRecord.current = null;
      storageIdentity.current.id = current.id;
    }
    const key = `roughdraft-draft:${current.id}`;
    const record = equalDraft(latest.current, storedDraft(current) ?? seed)
      ? null
      : JSON.stringify({
          revision: current.revision,
          draft: latest.current,
          inFlight: inFlight.current,
          stale: stale.current,
          baseVersion: storageIdentity.current.baseVersion,
        } satisfies BrowserRecovery);
    try {
      if (record) sessionStorage.setItem(key, record);
      else sessionStorage.removeItem(key);
    } catch {
      // The server sidecar is the primary recovery store.
    }
    try {
      if (record && !stale.current) {
        localStorage.setItem(key, record);
        lastLocalRecord.current = record;
      } else if (localStorage.getItem(key) === lastLocalRecord.current) {
        localStorage.removeItem(key);
        lastLocalRecord.current = null;
      }
    } catch {
      // A blocked browser store does not prevent server recovery.
    }
  }, [seed]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const updateDraft = useCallback(
    (update: (current: RevisionDraft) => RevisionDraft) => {
      const next = update(latest.current);
      if (equalDraft(next, latest.current)) return;
      latest.current = next;
      setDraft(next);
      storeLocally();
    },
    [storeLocally],
  );

  const run = useCallback(
    (
      action: "sync" | "base" | "save" | "send" | "recover",
      snapshot: RevisionDraft,
      fields?: object,
    ) => {
      const task = queue.current.then(async () => {
        if (action === "sync" && !equalDraft(snapshot, latest.current))
          return server.current;
        if (stale.current) {
          if (action === "sync") return server.current;
          if (action !== "save" && action !== "recover")
            throw new Error(
              "This review changed in another browser. Preserve this review separately before continuing.",
            );
        }
        const current = server.current;
        const path = `/${encodeURIComponent(current.id)}`;
        const saveFile =
          action === "sync" && needsFileSave(current, snapshot, paused.current);
        const endpoint =
          action === "sync"
            ? saveFile
              ? "save"
              : "draft"
            : action === "recover" || (action === "save" && stale.current)
              ? "fork"
              : action;
        if (
          endpoint === "draft" &&
          equalDraft(snapshot, storedDraft(current) ?? seed)
        )
          return current;
        inFlight.current = { draft: snapshot, selectsBase: action === "base" };
        storeLocally();
        const request = (route: string) =>
          revisionRequest<ComparisonReviewData>(`${path}/${route}`, {
            revision: current.revision,
            ...snapshot,
            ...fields,
          });
        const checkReviewChanged = async (error: unknown) => {
          if (!(error instanceof RevisionRequestError) || error.status !== 409)
            return false;
          const fresh = await revisionRequest<ComparisonReviewData>(path).catch(
            () => null,
          );
          if (!fresh || fresh.revision === current.revision) return false;
          server.current = fresh;
          // A closing page may finish this exact save after the replacement
          // page reads its initial revision. Acknowledge it without mistaking
          // our own completed request for another browser's different work.
          if (action === "sync" && equalDraft(snapshot, storedDraft(fresh)))
            return "acknowledged";
          stale.current = true;
          paused.current = true;
          if (mounted.current) {
            setWritePaused(true);
            setReviewChanged(true);
          }
          return true;
        };
        try {
          let next: ComparisonReviewData;
          try {
            next = await request(endpoint);
          } catch (error) {
            const changed = await checkReviewChanged(error);
            if (changed === "acknowledged") {
              next = server.current;
            } else {
              if (!saveFile || changed) throw error;
              // An outside write (or a failed filesystem write) stops automatic
              // writes immediately. Try to preserve the unsaved work in the sidecar.
              paused.current = true;
              if (mounted.current) {
                setWritePaused(true);
                setRecoveryError(
                  error instanceof Error ? error.message : String(error),
                );
              }
              try {
                next = await request("draft");
              } catch (draftError) {
                const draftChanged = await checkReviewChanged(draftError);
                if (draftChanged === "acknowledged") next = server.current;
                else throw draftError;
              }
            }
          }
          server.current = next;
          if (action === "base") latest.current = storedDraft(next) ?? snapshot;
          if (action === "save" || action === "base" || action === "recover") {
            paused.current = false;
            stale.current = false;
            storageIdentity.current.baseVersion = next.baseVersion ?? null;
          }
          if (mounted.current) {
            if (next.id !== current.id) {
              const url = new URL(window.location.href);
              url.search = new URLSearchParams({
                comparison: next.id,
              }).toString();
              window.history.replaceState(null, "", url);
            }
            setSession(next);
            if (action === "base") setDraft(latest.current);
            setWritePaused(paused.current);
            setReviewChanged(stale.current);
            if (!paused.current) setRecoveryError("");
          }
          return next;
        } finally {
          inFlight.current = null;
          storeLocally();
        }
      });
      queue.current = task.then(
        () => {},
        () => {},
      );
      return task;
    },
    [seed, storeLocally],
  );

  useEffect(() => {
    // A save can be acknowledged after the user has already undone/redone it.
    // Recheck newer work against every acknowledgement, even if it matched the
    // previously saved draft while that request was still in flight.
    if (
      equalDraft(draft, storedDraft(session) ?? seed) &&
      !needsFileSave(session, draft, paused.current)
    ) {
      setRecoveryPending(false);
      return;
    }
    let active = true;
    setRecoveryPending(true);
    const timer = window.setTimeout(() => {
      void run("sync", draft)
        .catch((error: Error) => {
          if (active) setRecoveryError(error.message);
        })
        .finally(() => {
          if (active) setRecoveryPending(false);
        });
    }, 300);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft, run, seed, session]);

  const readDraft = useCallback(() => latest.current, []);

  const flush = useCallback(async () => {
    const saved = await run("sync", latest.current);
    return !paused.current && !saved.targetChanged;
  }, [run]);

  const inspect = useCallback(
    (filename?: string) =>
      revisionRequest<InspectedDestination>(
        `/${encodeURIComponent(session.id)}/destination${filename ? `?${new URLSearchParams({ path: filename })}` : ""}`,
      ),
    [session.id],
  );

  return {
    session,
    draft,
    updateDraft,
    readDraft,
    run,
    inspect,
    recoveryError,
    recoveryPending,
    writePaused,
    reviewChanged,
    flush,
  };
}
