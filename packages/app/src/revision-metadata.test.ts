import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  documentMetadata,
  sameMetadata,
  withDocumentMetadata,
} from "./revision-metadata";
import { splitYamlDocumentMetadata } from "./markdown";

const feedback = [
  "comments:",
  "  c1:",
  "    body: Keep this review feedback.",
  "    by: User",
  '    at: "2026-11-21T18:00:00.000Z"',
  "suggestions:",
  "  s1:",
  "    by: AI",
  '    at: "2026-11-21T18:01:00.000Z"',
  "",
].join("\n");
const body = "# Plan\r\n\r\nKeep `{++literal++}` and {++proposal++}{#s1}.\r\n";

function metadataYaml(endmatter: string | null) {
  if (endmatter === null) throw new Error("Expected YAML metadata.");
  return parseYaml(endmatter.replace(/^---\r?\n/, ""));
}

describe("review document metadata", () => {
  it("compares document YAML while excluding review feedback", () => {
    const source = `---\r\ntitle: Old\r\n---\r\n\r\n${body}\r\n---\ncategory: plan\n${feedback}`;
    const metadata = documentMetadata(source);
    expect(metadata.frontmatter).toBe("---\r\ntitle: Old\r\n---\r\n\r\n");
    expect(metadataYaml(metadata.endmatter)).toEqual({
      category: "plan",
    });
    expect(
      sameMetadata(
        metadata,
        documentMetadata(
          source.replace("Keep this review feedback.", "A reply was added."),
        ),
      ),
    ).toBe(true);
    expect(
      sameMetadata(
        metadata,
        documentMetadata(source.replace("title: Old", "title: New")),
      ),
    ).toBe(false);
  });

  it("preserves the exact full source when document metadata is unchanged", () => {
    const source = `---\r\ntitle: "Quoted"\r\n---\r\n\r\n${body}\r\n---\ncategory: plan\n${feedback}`;
    expect(withDocumentMetadata(source, documentMetadata(source))).toBe(source);
  });

  it("replaces frontmatter without rewriting body or review YAML", () => {
    const source = `---\r\ntitle: Old\r\n---\r\n\r\n${body}\r\n---\n${feedback}`;
    expect(
      withDocumentMetadata(source, {
        frontmatter: "---\ntitle: New\n---\n\n",
        endmatter: null,
      }),
    ).toBe(
      source.replace(
        "---\r\ntitle: Old\r\n---\r\n\r\n",
        "---\ntitle: New\n---\n\n",
      ),
    );
  });

  it("changes document endmatter fields while retaining all review entries and exact body bytes", () => {
    const source = `${body}\r\n---\ncategory: old\nobsolete: true\n${feedback}`;
    const changed = withDocumentMetadata(source, {
      frontmatter: null,
      endmatter: "---\ncategory: new\npriority: 2\n",
    });
    expect(changed.startsWith(`${body}\r\n---\n`)).toBe(true);
    const split = splitYamlDocumentMetadata(changed);
    const yaml = metadataYaml(split.endmatter);
    expect(yaml.category).toBe("new");
    expect(yaml.priority).toBe(2);
    expect(yaml.obsolete).toBeUndefined();
    expect(yaml.comments).toEqual(parseYaml(feedback).comments);
    expect(yaml.suggestions).toEqual(parseYaml(feedback).suggestions);
    expect(changed).toContain("{++proposal++}{#s1}");
  });

  it("removes document metadata without deleting review feedback", () => {
    const source = `---\ntitle: Old\n---\n\n${body}\r\n---\ncategory: old\n${feedback}`;
    const changed = withDocumentMetadata(source, {
      frontmatter: null,
      endmatter: null,
    });
    expect(changed.startsWith(body)).toBe(true);
    const yaml = metadataYaml(splitYamlDocumentMetadata(changed).endmatter);
    expect(Object.keys(yaml).sort()).toEqual(["comments", "suggestions"]);
    expect(yaml.comments).toEqual(parseYaml(feedback).comments);
    expect(yaml.suggestions).toEqual(parseYaml(feedback).suggestions);
  });

  it("keeps an ordinary final YAML-looking section in the body", () => {
    const source = "# Notes\n\n---\ncategory: ordinary body\n";
    expect(documentMetadata(source)).toEqual({
      frontmatter: null,
      endmatter: null,
    });
    expect(
      withDocumentMetadata(source, { frontmatter: null, endmatter: null }),
    ).toBe(source);
  });

  it("does not import review entries from the chosen metadata", () => {
    const source = `${body}\r\n---\n${feedback}`;
    const changed = withDocumentMetadata(source, {
      frontmatter: null,
      endmatter: `---\ncategory: new\n${feedback.replace("Keep this review feedback.", "Replace the current comment")}`,
    });
    const yaml = metadataYaml(splitYamlDocumentMetadata(changed).endmatter);
    expect(yaml.category).toBe("new");
    expect(yaml.comments.c1.body).toBe("Keep this review feedback.");
  });
});
