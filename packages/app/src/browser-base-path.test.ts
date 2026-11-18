import { afterEach, describe, expect, it } from "vitest";
import {
  browserAnchorPath,
  browserBasePath,
  browserNavigationUrl,
  browserPath,
  browserRoutePath,
} from "./browser-base-path";

afterEach(() => {
  document.querySelector("base")?.remove(); // selector-check-ignore: semantic Markdown/HTML output is the behavior under test.
  window.history.replaceState({}, "", "/");
});

function useBase(prefix: string) {
  const base = document.createElement("base");
  base.setAttribute("href", prefix);
  document.head.append(base);
}

describe("browser paths behind a reverse proxy", () => {
  it("uses a configured prefix for API, assets, events and comparisons", () => {
    useBase("/editors/alice/");
    window.history.replaceState({}, "", "/editors/alice/notes/draft.md");
    expect(browserBasePath()).toBe("/editors/alice/");
    for (const route of [
      "/api/status",
      "/api/open-requests?path=notes.md",
      "/assets/editor.js",
      "/?comparison=review#note",
    ]) {
      expect(browserPath(route)).toBe(`/editors/alice${route}`);
    }
    expect(browserPath("/editors/alice/api/status")).toBe(
      "/editors/alice/api/status",
    );
    expect(browserRoutePath()).toBe("/notes/draft.md");
    expect(browserRoutePath("/editors/alice-other/draft.md")).toBe(
      "/editors/alice-other/draft.md",
    );
  });

  it("keeps private backend open requests on the public tab's origin and prefix", () => {
    useBase("/review/one/");
    const location = {
      origin: "https://editor.example",
      pathname: "/review/one/notes.md",
    };
    expect(
      browserNavigationUrl(
        "http://localhost:7373/?path=%2Fnotes.md#section",
        location,
      ),
    ).toBe("https://editor.example/review/one/?path=%2Fnotes.md#section");
  });

  it("defaults to root hosting without inferring authority from document names", () => {
    window.history.replaceState(
      {},
      "",
      "/roughdraft/arbitrary/document.md/page",
    );
    expect(browserBasePath()).toBe("/");
    expect(browserPath("/api/status")).toBe("/api/status");
    expect(browserRoutePath()).toBe("/roughdraft/arbitrary/document.md/page");
  });

  it("preserves the document query for in-document anchors under an asset base", () => {
    useBase("/review/one/");
    window.history.replaceState({}, "", "/review/one/?path=draft.md");
    expect(browserAnchorPath("#note")).toBe("/review/one/?path=draft.md#note");
    expect(browserAnchorPath("https://example.com/")).toBe(
      "https://example.com/",
    );
  });
});
