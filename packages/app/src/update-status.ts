import { browserPath } from "./browser-base-path";

export interface UpdateStatus {
  packageName: string;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  updateCommand: string;
}

export async function fetchUpdateStatus(): Promise<UpdateStatus | null> {
  try {
    const response = await fetch(browserPath("/api/update-status"));
    if (!response.ok) return null;

    const payload = (await response.json()) as Partial<UpdateStatus>;
    if (!payload.updateAvailable) return null;
    if (
      typeof payload.packageName !== "string" ||
      typeof payload.currentVersion !== "string" ||
      typeof payload.latestVersion !== "string" ||
      typeof payload.updateCommand !== "string"
    ) {
      return null;
    }

    return {
      packageName: payload.packageName,
      currentVersion: payload.currentVersion,
      latestVersion: payload.latestVersion,
      updateAvailable: true,
      updateCommand: payload.updateCommand,
    };
  } catch {
    return null;
  }
}
