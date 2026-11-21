import { useEffect, useState } from "react";
import type { DocumentInteractionMode } from "./PageCard";

export type RevisionView = "changes" | "rejected" | "accepted";
interface Preferences {
  interaction: DocumentInteractionMode;
  formatted: boolean;
  view: RevisionView;
}
const defaults: Preferences = {
  interaction: "editing",
  formatted: true,
  view: "changes",
};

export function useRevisionPreferences(id: string) {
  const key = `roughdraft-view:${id}`;
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "null");
      return {
        interaction: ["editing", "suggesting", "viewing"].includes(
          stored?.interaction,
        )
          ? stored.interaction
          : defaults.interaction,
        formatted:
          typeof stored?.formatted === "boolean"
            ? stored.formatted
            : defaults.formatted,
        view: ["changes", "rejected", "accepted"].includes(stored?.view)
          ? stored.view
          : defaults.view,
      };
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(preferences));
    } catch {
      /* Reading remains available when browser storage is disabled. */
    }
  }, [key, preferences]);
  return [
    preferences,
    (update: Partial<Preferences>) =>
      setPreferences((previous) => ({ ...previous, ...update })),
  ] as const;
}
