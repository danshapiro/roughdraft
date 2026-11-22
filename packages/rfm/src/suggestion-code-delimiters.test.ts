import { expect, test } from "vitest";
import {
  cleanRoughdraftMarkdown,
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "./index";

const metadata = '{id="s1" by="user" at="2026-01-01T00:00:00.000Z"}';
const literal = "{~~old~>new~~} {++added++} {--deleted--}";
for (const payload of [
  `Use \`${literal}\` exactly.`,
  `\n\`\`\`md\n${literal}\n\`\`\`\n`,
  `\n~~~~md\n${literal}\n~~~\n~~~~\n`,
  `\n> \`\`\`md\n> ${literal}\n> \`\`\`\n`,
  `\n- \`\`\`md\n  ${literal}\n  \`\`\`\n`,
  `\`\`\`md\n${literal}\n\`\`\``,
  `~~~md\n${literal}\n~~~`,
  `\n\`\`\`md\n> \`\`\`\n${literal}\n\`\`\`\n`,
  `\n\`\`\`md\n- \`\`\`\n${literal}\n\`\`\`\n`,
  `\n> \`\`\`md\n> > \`\`\`\n> ${literal}\n> \`\`\`\n`,
]) {
  for (const kind of ["addition", "deletion", "substitution"] as const) {
    test(`outer ${kind} ignores review delimiters in code: ${JSON.stringify(payload)}`, () => {
      const after = payload
        .replace("exactly", "unchanged")
        .replace("old", "older");
      const source =
        (kind === "addition"
          ? `{++${payload}++}`
          : kind === "deletion"
            ? `{--${payload}--}`
            : `{~~${payload}~>${after}~~}`) +
        metadata +
        "\n";
      const index = extractRoughdraftReviewIndex(source);
      expect(validateRoughdraftMarkdown(source).ok).toBe(true);
      expect(index.items).toHaveLength(1);
      expect(index.items[0]).toMatchObject({
        id: "s1",
        kind: "suggestion",
        suggestionKind: kind,
        text: kind === "substitution" ? after : payload,
      });
      expect(cleanRoughdraftMarkdown(source)).toBe(
        kind === "addition" ? "\n" : `${payload}\n`,
      );
    });
  }
}
