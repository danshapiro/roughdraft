// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cleanRevisionMarkdown } from "./revision-markdown";

describe("Markdown written or exported from a review", () => {
  it("keeps original wording until suggestions are kept", () => {
    expect(
      cleanRevisionMarkdown(
        "# Notes\n\nKeep {--this--} and {~~old~>new~~}{++ extra++}. {>>Feedback<<}\n",
      ),
    ).toBe("# Notes\nKeep this and old.\n");
  });

  it("preserves exact clean source and unrelated Markdown metadata", () => {
    const clean = "---\r\nname: example\r\n---\r\n\r\n* one\r\n* two";
    expect(cleanRevisionMarkdown(clean)).toBe(clean);
    expect(
      cleanRevisionMarkdown(
        "# Notes\n\n{++new++}{#s1}Old\n\n---\nother: true\nsuggestions:\n  s1:\n    by: User\n    at: 2026-11-18T00:00:00Z\n",
      ),
    ).toBe("# Notes\nOld\n\n---\nother: true\n");
  });
});
