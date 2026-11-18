import { browserPath } from "./browser-base-path";
import type { StorageBackend } from "./storage";
import { ApiBackend } from "./api-backend";
import { LocalStorageBackend } from "./local-storage-backend";
import { RemoteBackend } from "./remote-backend";

interface StatusPayload {
  backend?: string;
  projectDir?: string;
  stateless?: boolean;
  capabilities?: { remoteDocuments?: boolean };
}

export async function detectBackend(): Promise<StorageBackend> {
  if (import.meta.env.VITE_PREVIEW_WEB === "1") {
    return new LocalStorageBackend();
  }

  const sessionId = readSessionIdFromUrl();
  const token = readTokenFromUrl();

  let statusPayload: StatusPayload | null = null;

  try {
    const res = await fetch(browserPath("/api/status"));
    if (res.ok) {
      statusPayload = (await res.json()) as StatusPayload;
    }
  } catch {
    // network error — no server available
  }

  if (statusPayload) {
    if (sessionId && statusPayload.capabilities?.remoteDocuments) {
      try {
        return await RemoteBackend.create(sessionId, token);
      } catch (error) {
        console.error("Could not initialize remote backend:", error);
        throw error;
      }
    }

    if (statusPayload.backend === "local-files") {
      return new ApiBackend({
        kind: "local-files",
        label: "Local files",
        detail: statusPayload.stateless
          ? "Open a markdown file"
          : "Markdown file on disk",
        projectPath: statusPayload.projectDir,
      });
    }
  }

  return new LocalStorageBackend();
}

function readSessionIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const session = params.get("session")?.trim();
  return session && session.length > 0 ? session : null;
}

function readTokenFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return params.get("token")?.trim() ?? "";
}
