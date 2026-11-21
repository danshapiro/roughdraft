import { CloudOff, Cloud } from "lucide-react";
import { useEffect, useState } from "react";
import { RemoteBackend, type RemoteSessionStatus } from "../remote-backend";
import type { StorageBackend } from "../storage";

interface RemoteSessionBannerProps {
  backend: StorageBackend | null;
}

export function RemoteSessionBanner({ backend }: RemoteSessionBannerProps) {
  const [status, setStatus] = useState<RemoteSessionStatus>("disconnected");

  useEffect(() => {
    if (!(backend instanceof RemoteBackend)) {
      return;
    }
    return backend.onSessionStatusChange(setStatus);
  }, [backend]);

  if (!(backend instanceof RemoteBackend)) {
    return null;
  }

  if (status === "connected") {
    return (
      <div
        role="status"
        data-testid="remote-session-connected"
        aria-label="Remote session connected"
        className="fixed top-3 right-3 z-40 flex items-center gap-2 rounded-md border border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 px-2.5 py-1.5 text-xs text-emerald-900 dark:text-emerald-100 shadow"
      >
        <Cloud className="size-3.5" aria-hidden="true" />
        <span className="font-medium">Remote session connected</span>
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="remote-session-disconnected"
      aria-label="Remote session disconnected"
      className="fixed top-3 left-1/2 z-50 flex w-[min(calc(100vw-1rem),52rem)] -translate-x-1/2 items-start gap-2.5 rounded-[8px] border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 px-3 py-3 text-amber-950 dark:text-amber-100 shadow-[0_14px_40px_rgba(120,53,15,0.18)] dark:shadow-[0_14px_40px_rgba(0,0,0,0.4)] sm:px-4"
    >
      <CloudOff
        className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-5">
          Remote session disconnected
        </div>
        <div className="mt-0.5 text-xs leading-5 text-amber-900 dark:text-amber-200">
          The CLI on the source machine is no longer connected. Reopen
          <span className="font-mono"> roughdraft open </span>
          from that machine to keep editing.
        </div>
      </div>
    </div>
  );
}
