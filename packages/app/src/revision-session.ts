import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ComparisonReviewComment,
  ComparisonReviewData,
  EditorDraft,
} from "./comparison-types";

export class RevisionRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function revisionRequest<T>(
  path: string,
  body?: object,
): Promise<T> {
  const response = await fetch(
    `/api/comparisons${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
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

function equalDraft(a: RevisionDraft, b: RevisionDraft | null | undefined) {
  return Boolean(
    b &&
      a.markdown === b.markdown &&
      a.cleanMarkdown === b.cleanMarkdown &&
      JSON.stringify(a.decisions) === JSON.stringify(b.decisions) &&
      JSON.stringify(a.reviewComments) === JSON.stringify(b.reviewComments),
  );
}

export function useRevisionSession(
  initial: ComparisonReviewData,
  seed: RevisionDraft,
) {
  const key = `roughdraft-draft:${initial.id}`;
  const path = `/${encodeURIComponent(initial.id)}`;
  const [session, setSession] = useState(initial);
  const server = useRef(initial);
  const [draft, setDraft] = useState<RevisionDraft>(() => {
    try {
      const browser = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        (browser?.revision === initial.revision ||
          (browser?.revision + 1 === initial.revision &&
            browser.inFlight &&
            equalDraft(browser.inFlight, storedDraft(initial)))) &&
        typeof browser.draft?.markdown === "string" &&
        Array.isArray(browser.draft.reviewComments)
      )
        return browser.draft;
    } catch {
      /* Server recovery remains available. */
    }
    return storedDraft(initial) ?? seed;
  });
  const latest = useRef(draft);
  const mounted = useRef(false);
  const queue = useRef(Promise.resolve());
  const inFlight = useRef<RevisionDraft | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryPending, setRecoveryPending] = useState(false);
  const storeLocally = useCallback(() => {
    try {
      if (equalDraft(latest.current, storedDraft(server.current)))
        localStorage.removeItem(key);
      else
        localStorage.setItem(
          key,
          JSON.stringify({
            revision: server.current.revision,
            draft: latest.current,
            inFlight: inFlight.current,
          }),
        );
    } catch {
      /* A blocked browser store does not prevent server recovery. */
    }
  }, [key]);

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
      action: "draft" | "save" | "send",
      snapshot: RevisionDraft,
      fields?: object,
    ) => {
      const task = queue.current.then(async () => {
        if (
          action === "draft" &&
          equalDraft(snapshot, storedDraft(server.current))
        )
          return server.current;
        inFlight.current = snapshot;
        storeLocally();
        try {
          const next = await revisionRequest<ComparisonReviewData>(
            `${path}/${action}`,
            {
              revision: server.current.revision,
              ...snapshot,
              ...fields,
            },
          );
          server.current = next;
          if (mounted.current) {
            setSession(next);
            setRecoveryError("");
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
    [path, storeLocally],
  );

  useEffect(() => {
    if (
      equalDraft(draft, storedDraft(server.current)) ||
      (draft === seed && !storedDraft(server.current))
    ) {
      setRecoveryPending(false);
      return;
    }
    let active = true;
    setRecoveryPending(true);
    const timer = window.setTimeout(() => {
      void run("draft", draft)
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
  }, [draft, run, seed]);

  const inspect = useCallback(
    (filename?: string) =>
      revisionRequest<InspectedDestination>(
        `${path}/destination${filename ? `?${new URLSearchParams({ path: filename })}` : ""}`,
      ),
    [path],
  );

  return {
    session,
    draft,
    updateDraft,
    run,
    inspect,
    recoveryError,
    recoveryPending,
  };
}
