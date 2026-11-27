import { expect, test } from "vitest";
import { rebaseRemoteMetadata } from "./revision-remote-metadata";
test("a worker result preserves newer local metadata while adding an independent body edit", () => {
  const base = "---\ntitle: Original\n---\n\nBody.\n";
  expect(
    rebaseRemoteMetadata(
      base,
      base.replace("Original", "Newer"),
      base.replace("Body.", "Remote body."),
    ),
  ).toBe("---\ntitle: Newer\n---\n\nRemote body.\n");
});
test("overlapping newer metadata waits for a new merge instead of overwriting it", () => {
  const base = "---\ntitle: Original\n---\n\nBody.\n";
  expect(
    rebaseRemoteMetadata(
      base,
      base.replace("Original", "Local"),
      base.replace("Original", "Remote"),
    ),
  ).toBeNull();
});
