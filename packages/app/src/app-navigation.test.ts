import { afterEach, describe, expect, it } from "vitest";
import {
  PREVIEW_PATH,
  ROUGHDRAFT_FLAVORED_MARKDOWN_PATH,
  buildLocationForLinkedMarkdownDocument,
  getRequestedPathState,
  syncRequestedPathInUrl,
} from "./app-navigation";

describe("app navigation", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("reads absolute markdown paths from the path query parameter", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2F.claude%2Fplans%2Fexample.md",
    );

    expect(getRequestedPathState()).toEqual({
      rawPath: "/Users/me/.claude/plans/example.md",
      projectPath: "/Users/me/.claude/plans",
      documentPath: "example.md",
    });
  });

  it("keeps absolute paths in the path query parameter", () => {
    window.history.replaceState(null, "", "/");

    syncRequestedPathInUrl("/Users/me/.claude/plans/example.md");

    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe(
      "?path=%2FUsers%2Fme%2F.claude%2Fplans%2Fexample.md",
    );
  });

  it("does not treat reserved app pages as file paths", () => {
    window.history.replaceState(null, "", ROUGHDRAFT_FLAVORED_MARKDOWN_PATH);

    expect(getRequestedPathState()).toEqual({
      rawPath: null,
      projectPath: null,
      documentPath: null,
    });

    window.history.replaceState(null, "", PREVIEW_PATH);

    expect(getRequestedPathState()).toEqual({
      rawPath: null,
      projectPath: null,
      documentPath: null,
    });
  });

  it("builds Roughdraft routes for linked markdown documents", () => {
    window.history.replaceState(
      null,
      "",
      "/?path=%2FUsers%2Fme%2Fproject%2F.context%2Flocal-link-source.md",
    );

    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project/.context",
        currentDocumentPath: "local-link-source.md",
        href: "local-link-target.md",
      }),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2F.context%2Flocal-link-target.md");
  });

  it("resolves nested markdown links relative to the current document", () => {
    window.history.replaceState(null, "", "/");

    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project",
        currentDocumentPath: "notes/source.md",
        href: "../index.md#summary",
      }),
    ).toBe("/?path=%2FUsers%2Fme%2Fproject%2Findex.md#summary");
  });

  it("leaves non-markdown links for the file resolver", () => {
    expect(
      buildLocationForLinkedMarkdownDocument({
        projectPath: "/Users/me/project",
        currentDocumentPath: "source.md",
        href: "diagram.png",
      }),
    ).toBeNull();
  });

  it.each([
    ["other%20file.md", "/home/dan/docs/other file.md"],
    ["other file.md", "/home/dan/docs/other file.md"],
    ["other%23file.md", "/home/dan/docs/other#file.md"],
    ["other%3Ffile.md", "/home/dan/docs/other?file.md"],
    ["other%25file.md", "/home/dan/docs/other%file.md"],
    ["100%Accuracy.md", "/home/dan/docs/100%Accuracy.md"],
    ["caf%C3%A9.md", "/home/dan/docs/café.md"],
  ])("resolves the encoded Markdown link %s", (href, expectedPath) => {
    const location = buildLocationForLinkedMarkdownDocument({
      projectPath: "/home/dan/docs",
      currentDocumentPath: "source.md",
      href,
    });
    if (!location) throw new Error("Expected a Markdown document location");

    expect(
      new URL(location, window.location.origin).searchParams.get("path"),
    ).toBe(expectedPath);
  });

  it.each([
    "my#notes",
    "my?notes",
    "my%20notes",
  ])("preserves literal filename characters in directory %s", (directory) => {
    const location = buildLocationForLinkedMarkdownDocument({
      projectPath: `/home/dan/${directory}`,
      currentDocumentPath: "source.md",
      href: "target.md#section",
      unified: true,
    });
    if (!location) throw new Error("Expected a Markdown document location");

    const url = new URL(location, window.location.origin);
    expect(url.searchParams.get("path")).toBe(
      `/home/dan/${directory}/target.md`,
    );
    expect(url.searchParams.get("editor")).toBe("unified");
    expect(url.hash).toBe("#section");
  });
});
