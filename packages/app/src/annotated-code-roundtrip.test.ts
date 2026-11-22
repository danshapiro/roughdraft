import { getSchema, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import { expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";

import {
  acceptCriticChangeTransaction,
  createEditorExtensions,
} from "./editor-extensions";
import { projectAcceptedDocument } from "./revision-projection";

const comments = new Map([
  [
    "c1",
    {
      id: "c1",
      content: "Check these lines.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
]);
const anchor = [{ type: "commentRef", attrs: { commentIds: ["c1"] } }];

for (const code of [
  "alpha\n  beta\nomega",
  "alpha\n```\nomega",
  "alpha\n~~~\nomega",
  "\n alpha\t\n  beta \n\n",
  "α = 1\n\n\tbravo",
]) {
  test(`annotated code preserves exact whitespace and its fence boundary: ${JSON.stringify(code)}`, () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "md" },
          content: [{ type: "text", text: code, marks: anchor }],
        },
      ],
    };
    const serialized = editorStateToCriticMarkdown(doc, comments);
    const restored = criticMarkdownToEditorState(serialized);
    expect(restored.doc.content).toHaveLength(1);
    expect(restored.doc.content?.[0]).toMatchObject({
      type: "codeBlock",
      attrs: { language: "md" },
    });
    expect(
      restored.doc.content?.[0].content?.map((node) => node.text).join(""),
    ).toBe(code);
    expect(
      restored.doc.content?.[0].content?.every((node) =>
        node.marks?.some((mark) => mark.type === "commentRef"),
      ),
    ).toBe(true);
    expect(restored.comments.get("c1")?.content).toBe("Check these lines.");
  });
}

test("a partial code annotation preserves whitespace both inside and outside its anchor", () => {
  const selected = " alpha\n\tbeta ";
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "text" },
        content: [
          { type: "text", text: "prefix\n" },
          { type: "text", text: selected, marks: anchor },
          { type: "text", text: "\nsuffix" },
        ],
      },
    ],
  };
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(doc, comments),
  );
  expect(
    restored.doc.content?.[0].content?.map((node) => node.text).join(""),
  ).toBe(`prefix\n${selected}\nsuffix`);
  expect(
    restored.doc.content?.[0].content
      ?.filter((node) => node.marks?.some((mark) => mark.type === "commentRef"))
      .map((node) => node.text)
      .join(""),
  ).toBe(selected);
});

test("a structural proposal around annotated multiline code preserves both exact code versions", () => {
  const before = "alpha\n```\nomega";
  const after = "alpha\n````\nnew omega";
  const side = (
    text: string,
    kind: "substitution-old" | "substitution-new",
  ): JSONContent => {
    const change = {
      kind,
      changeId: "s1",
      authorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    return {
      type: "criticChangeBlock",
      attrs: { change },
      content: [
        {
          type: "codeBlock",
          attrs: { language: "md" },
          content: [
            {
              type: "text",
              text,
              marks: [...anchor, { type: "criticChange", attrs: change }],
            },
          ],
        },
      ],
    };
  };
  const doc: JSONContent = {
    type: "doc",
    content: [
      side(before, "substitution-old"),
      side(after, "substitution-new"),
    ],
  };
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(doc, comments),
  );
  const schema = getSchema(createEditorExtensions(""));
  const state = EditorState.create({ doc: schema.nodeFromJSON(restored.doc) });
  const original = projectAcceptedDocument(state.doc).doc;
  expect(original.childCount).toBe(1);
  expect(original.firstChild?.type.name).toBe("codeBlock");
  expect(original.textContent).toBe(before);
  const kept = acceptCriticChangeTransaction(state, "s1");
  expect(kept).not.toBeNull();
  expect(kept?.doc.childCount).toBe(1);
  expect(kept?.doc.firstChild?.type.name).toBe("codeBlock");
  expect(kept?.doc.textContent).toBe(after);
  expect(restored.comments.get("c1")?.content).toBe("Check these lines.");
});

test("plain code keeps a user's final empty code line after saving and reloading", () => {
  const code = "alpha\n";
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "text" },
        content: [{ type: "text", text: code }],
      },
    ],
  };
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(doc, new Map()),
  );
  expect(restored.doc.content).toHaveLength(1);
  expect(restored.doc.content?.[0].type).toBe("codeBlock");
  expect(
    restored.doc.content?.[0].content?.map((node) => node.text).join(""),
  ).toBe(code);
});
