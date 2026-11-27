import { expect, test, vi } from "vitest";
import {
  cleanRoughdraftMarkdown,
  roughdraftAttachmentContexts,
} from "./index.js";

function fixture(reading: string, newline: string) {
  const before = [
    "---",
    "title: Literal review examples",
    "---",
    "",
    "Escaped \\{++literal++\\} and inline `{~~old~>new~~}` remain literal.",
    "",
    "````markdown",
    "{>>literal comment<<}{#literal}",
    "```text",
    "{++literal addition++}",
    "```",
    "````",
    "",
    "Use {~~old **wording**~>new wording~~}{#s1} and {==this anchor==}{>>Feedback<<}{#c1}.",
    "",
  ].join(newline);
  const after = [
    "",
    "",
    "Unfinished {++addition and {~~substitution.",
    "",
  ].join(newline);
  return {
    markdown: before + reading + after,
    expected:
      before
        .replace("{~~old **wording**~>new wording~~}{#s1}", "old **wording**")
        .replace("{==this anchor==}{>>Feedback<<}{#c1}", "this anchor") +
      reading +
      after,
  };
}

test.each([
  "\n",
  "\r\n",
])("ordinary source runs do not probe every character for review delimiters (%j)", (newline) => {
  const project = (repeats: number) => {
    const { markdown, expected } = fixture(
      "Ordinary reading words preserve café and 👩🏽‍💻 exactly. ".repeat(
        repeats,
      ),
      newline,
    );
    const startsWith = String.prototype.startsWith;
    let probes = 0;
    const spy = vi
      .spyOn(String.prototype, "startsWith")
      .mockImplementation(function (
        this: string,
        ...args: Parameters<typeof startsWith>
      ) {
        probes++;
        return startsWith.apply(this, args);
      });
    try {
      expect(cleanRoughdraftMarkdown(markdown)).toBe(expected);
      return probes;
    } finally {
      spy.mockRestore();
    }
  };
  const short = project(1);
  const long = project(2_000);
  expect(
    long,
    "delimiter probes should grow with syntax boundaries, not every ordinary source character",
  ).toBeLessThanOrEqual(short + 16);
});

test.each([
  "\n",
  "\r\n",
])("attachment contexts still stop at exact offsets within ordinary runs and trim only a single separator space (%j)", (newline) => {
  const markdown = `First ordinary reading passage. ${newline}Second reading passage.  ${newline}Third passage with \\{++literal++\\} and \`code\`.${newline}`;
  const offsets = [
    markdown.indexOf("reading") + 3,
    markdown.indexOf("Second"),
    markdown.indexOf("Third"),
    markdown.length,
  ];
  const contexts = roughdraftAttachmentContexts(markdown, offsets);
  const attachment = markdown.replace(
    `passage. ${newline}`,
    `passage.${newline}`,
  );
  expect(contexts.get(offsets[0])).toBe(
    markdown.slice(0, offsets[0]).slice(-40),
  );
  expect(contexts.get(offsets[1])).toBe(
    markdown
      .slice(0, offsets[1])
      .replace(`passage. ${newline}`, `passage.${newline}`)
      .slice(-40),
  );
  expect(contexts.get(offsets[2])).toBe(
    attachment.slice(0, offsets[2] - 1).slice(-40),
  );
  expect(contexts.get(markdown.length)).toBe(attachment.slice(-40));
});
