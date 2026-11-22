import {
  extractRoughdraftReviewIndex,
  validateRoughdraftMarkdown,
} from "@roughdraft/rfm";
import type { JSONContent } from "@tiptap/core";
import { expect, test } from "vitest";
import {
  criticMarkdownToEditorState,
  editorStateToCriticMarkdown,
} from "./critic-markup";
import {
  cleanRevisionMarkdown,
  cleanRevisionSourceMarkdown,
} from "./revision-markdown";

function textContent(node: { text?: string; content?: unknown[] }): string {
  return (
    node.text ??
    (node.content ?? [])
      .map((child) => textContent(child as Parameters<typeof textContent>[0]))
      .join("")
  );
}

test("inline comment bodies containing a closing marker remain one whole comment", () => {
  const original =
    "Read {==guidance==}{>>Original comment<<}{#c1} carefully.\n";
  const parsed = criticMarkdownToEditorState(original);
  const content =
    "Use the closing marker <<} in this example; keep this comment whole.";
  const comment = parsed.comments.get("c1");
  if (!comment) throw new Error("Missing original comment");
  const serialized = editorStateToCriticMarkdown(
    parsed.doc,
    new Map([["c1", { ...comment, content }]]),
  );
  const restored = criticMarkdownToEditorState(serialized);
  expect(textContent(restored.doc)).toBe("Read guidance carefully.");
  expect(restored.comments.get("c1")?.content).toBe(content);
});

test("literal review markers in formatted document text remain text through serialization", () => {
  const literal = "Please type {>>literal markers<<} exactly.";
  const doc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: literal }] },
    ],
  };
  const serialized = editorStateToCriticMarkdown(doc, new Map());
  expect(textContent(criticMarkdownToEditorState(serialized).doc)).toBe(
    literal,
  );
  expect(cleanRevisionMarkdown(serialized)).toContain("literal markers");
});

for (const content of [
  String.raw`Keep C:\temp\notes.md unchanged.`,
  String.raw`Keep two backslashes \\ unchanged.`,
  "Literal substitution {~~old~>new~~}, addition {++value++}, deletion {--value--}.",
]) {
  test(`ordinary authored comment text preserves its exact spelling: ${content}`, () => {
    const parsed = criticMarkdownToEditorState(
      `Read {==guidance==}{>>${content}<<}{#c1}.\n`,
    );
    expect(parsed.comments.get("c1")?.content).toBe(content);
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(parsed.doc, parsed.comments),
    );
    expect(restored.comments.get("c1")?.content).toBe(content);
    expect(textContent(restored.doc)).toBe("Read guidance.");
  });
}

test("overlapping comment fragments retain spaces inside each original anchor", () => {
  const c1 = {
    id: "c1",
    content: "First",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const c2 = { ...c1, id: "c2", content: "Second" };
  const segment = (text: string, commentIds: string[]) => ({
    type: "text",
    text,
    marks: [{ type: "commentRef", attrs: { commentIds } }],
  });
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          segment("bravo ", ["c1"]),
          segment("charlie", ["c1", "c2"]),
          segment(" delta", ["c2"]),
        ],
      },
    ],
  };
  const serialized = editorStateToCriticMarkdown(
    doc,
    new Map([
      ["c1", c1],
      ["c2", c2],
    ]),
  );
  const restored = criticMarkdownToEditorState(serialized);
  const anchors = new Map<string, string>();
  const visit = (node: JSONContent) => {
    for (const mark of node.marks ?? []) {
      if (mark.type === "commentRef")
        for (const id of mark.attrs.commentIds)
          anchors.set(id, (anchors.get(id) ?? "") + (node.text ?? ""));
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(restored.doc);
  expect(textContent(restored.doc)).toBe("bravo charlie delta");
  expect(anchors.get("c1")).toBe("bravo charlie");
  expect(anchors.get("c2")).toBe("charlie delta");
  expect(validateRoughdraftMarkdown(serialized).ok).toBe(true);
  expect(
    extractRoughdraftReviewIndex(serialized).items.map((item) => [
      item.id,
      item.text,
      item.anchorText,
    ]),
  ).toEqual([
    ["c1", "First", "bravo charlie"],
    ["c2", "Second", "charlie delta"],
  ]);
});

test("a whitespace-only overlap keeps the word separator and its comment anchors", () => {
  const comments = new Map([
    [
      "c1",
      { id: "c1", content: "First", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    [
      "c2",
      { id: "c2", content: "Second", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  ]);
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "bravo",
            marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
          },
          {
            type: "text",
            text: " ",
            marks: [
              { type: "commentRef", attrs: { commentIds: ["c1", "c2"] } },
            ],
          },
          {
            type: "text",
            text: "charlie",
            marks: [{ type: "commentRef", attrs: { commentIds: ["c2"] } }],
          },
        ],
      },
    ],
  };
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(doc, comments),
  );
  expect(textContent(restored.doc)).toBe("bravo charlie");
  const separator = restored.doc.content?.[0].content?.find(
    (node) => node.text === " ",
  );
  expect(
    separator?.marks?.find((mark) => mark.type === "commentRef")?.attrs
      ?.commentIds,
  ).toEqual(["c1", "c2"]);
});

for (const literal of [
  "literal ==} close",
  "literal {==highlight==} example",
  String.raw`Keep \\ and ==} ~> ~~} ++} --} <<} exactly.`,
]) {
  test(`comment anchors preserve literal closing markers: ${literal}`, () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: literal,
              marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
            },
          ],
        },
      ],
    };
    const comments = new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Feedback",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(doc, comments),
    );
    expect(textContent(restored.doc)).toBe(literal);
    expect(
      restored.doc.content?.[0].content?.[0].marks?.find(
        (mark) => mark.type === "commentRef",
      )?.attrs?.commentIds,
    ).toEqual(["c1"]);
  });
}

for (const kind of ["addition", "deletion", "substitution-old"] as const) {
  test(`literal closing markers stay inside a ${kind} suggestion`, () => {
    const old = String.raw`Keep \\ and ~~} ++} --} <<} ~> here.`;
    const next = String.raw`Then \\ and ~> ~~} ++} --} stay.`;
    const attrs = {
      kind,
      changeId: "s1",
      authorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const content: JSONContent[] = [
      { type: "text", text: old, marks: [{ type: "criticChange", attrs }] },
    ];
    if (kind === "substitution-old")
      content.push({
        type: "text",
        text: next,
        marks: [
          {
            type: "criticChange",
            attrs: { ...attrs, kind: "substitution-new" },
          },
        ],
      });
    const doc: JSONContent = {
      type: "doc",
      content: [{ type: "paragraph", content }],
    };
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(doc, new Map()),
    );
    expect(textContent(restored.doc)).toBe(
      kind === "substitution-old" ? old + next : old,
    );
  });
}

for (const literal of [
  "literal {~~old~>new~~} here",
  "literal ~~here~~ text",
  "literal ~here~ text",
]) {
  test(`typed tildes remain literal document text: ${literal}`, () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: literal }] },
      ],
    };
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(doc, new Map()),
    );
    expect(textContent(restored.doc)).toBe(literal);
    expect(restored.doc.content?.[0].content?.[0].marks).toBeUndefined();
  });
}

for (const content of [
  "First paragraph.\n\nSecond paragraph.",
  'Please add:\n\n---\ncomments:\n  c2:\n    body: Example\n    by: user\n    at: "2026-01-01T00:00:00.000Z"',
]) {
  test(`multiline comments stay feedback rather than becoming document blocks: ${content}`, () => {
    const parsed = criticMarkdownToEditorState(
      "Read {==guidance==}{>>Original<<}{#c1} carefully.\n",
    );
    const comment = parsed.comments.get("c1");
    if (!comment) throw new Error("Missing original comment");
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(
        parsed.doc,
        new Map([["c1", { ...comment, content }]]),
      ),
    );
    expect(textContent(restored.doc)).toBe("Read guidance carefully.");
    expect(
      [...restored.comments.values()].map((item) => [item.id, item.content]),
    ).toEqual([["c1", content]]);
  });
}

test("a commented code slice containing a literal anchor closer keeps its exact bytes", () => {
  const literal = String.raw`const marker = "==}"; // \ and ~~ unchanged`;
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [
          {
            type: "text",
            text: literal,
            marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
          },
        ],
      },
    ],
  };
  const comments = new Map([
    [
      "c1",
      { id: "c1", content: "Feedback", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  ]);
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(doc, comments),
  );
  expect(textContent(restored.doc)).toBe(literal);
  expect(
    restored.doc.content?.[0].content?.[0].marks?.find(
      (mark) => mark.type === "commentRef",
    )?.attrs?.commentIds,
  ).toEqual(["c1"]);
});

for (const literal of ["<span>text</span> & value", "&copy; is literal"]) {
  for (const mode of ["plain", "comment", "addition", "deletion"] as const) {
    test(`literal HTML and entities remain text in ${mode}: ${literal}`, () => {
      const marks =
        mode === "plain"
          ? []
          : mode === "comment"
            ? [{ type: "commentRef", attrs: { commentIds: ["c1"] } }]
            : [
                {
                  type: "criticChange",
                  attrs: {
                    kind: mode,
                    changeId: "s1",
                    authorType: "user",
                    createdAt: "2026-01-01T00:00:00.000Z",
                  },
                },
              ];
      const doc: JSONContent = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: literal, marks }],
          },
        ],
      };
      const comments = new Map([
        [
          "c1",
          {
            id: "c1",
            content: "Feedback",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      ]);
      const restored = criticMarkdownToEditorState(
        editorStateToCriticMarkdown(doc, comments),
      );
      expect(textContent(restored.doc)).toBe(literal);
    });
  }
}

for (const literal of [
  'const markup = "{==inner==}{>>literal<<}";',
  'const markup = "==}{>>literal<<}";',
  'const markup = \'{==inner==}{>>literal<<}{id="c7" by="user" at="2026-01-01T00:00:00.000Z"}\';',
  String.raw`const start = "{=="; const path = "C:\\notes\\";`,
]) {
  test(`unsafe commented code preserves nested syntax without guessing: ${literal}`, () => {
    const comments = new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Real feedback",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);
    const doc: JSONContent = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [
            {
              type: "text",
              text: literal,
              marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
            },
          ],
        },
      ],
    };
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(doc, comments),
    );
    expect(textContent(restored.doc)).toBe(literal);
    expect(
      [...restored.comments.values()].map((item) => [item.id, item.content]),
    ).toEqual([["c1", "Real feedback"]]);
    expect(
      restored.doc.content?.[0].content?.[0].marks?.find(
        (mark) => mark.type === "commentRef",
      )?.attrs?.commentIds,
    ).toEqual(["c1"]);
  });
}

test("adjacent safe and encoded code anchors preserve paths and their separate comments", () => {
  const first = String.raw`literal {==nested==}{>>inside<<} \\path`;
  const second = String.raw`C:\\notes\\file.md`;
  const comment = (id: string) => ({
    id,
    content: `Feedback ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const mark = (id: string) => [
    { type: "commentRef", attrs: { commentIds: [id] } },
  ];
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "text" },
        content: [
          { type: "text", text: first, marks: mark("c1") },
          { type: "text", text: " | " },
          { type: "text", text: second, marks: mark("c2") },
          { type: "text", text: " | " },
          { type: "text", text: second, marks: mark("c1") },
        ],
      },
    ],
  };
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(
      doc,
      new Map([
        ["c1", comment("c1")],
        ["c2", comment("c2")],
      ]),
    ),
  );
  expect(textContent(restored.doc)).toBe(`${first} | ${second} | ${second}`);
  expect(
    [...restored.comments.values()].map((item) => [item.id, item.content]),
  ).toEqual([
    ["c1", "Feedback c1"],
    ["c2", "Feedback c2"],
  ]);
  expect(
    restored.doc.content?.[0].content
      ?.filter((node) => node.marks?.some((m) => m.type === "commentRef"))
      .map((node) => [
        node.text,
        node.marks?.find((m) => m.type === "commentRef")?.attrs?.commentIds,
      ]),
  ).toEqual([
    [first, ["c1"]],
    [second, ["c2"]],
    [second, ["c1"]],
  ]);
});

for (const literal of [
  "{==inner==}{>>literal<<}",
  String.raw`{==start \\path ==} and \\`,
]) {
  test(`commented inline code uses explicit encoding without changing code bytes: ${literal}`, () => {
    const parsed = criticMarkdownToEditorState(
      '{==`seed`==}{>>Feedback<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}\n',
    );
    const text = parsed.doc.content?.[0].content?.[0];
    if (!text) throw new Error("Missing inline-code text");
    text.text = literal;
    const restored = criticMarkdownToEditorState(
      editorStateToCriticMarkdown(parsed.doc, parsed.comments),
    );
    expect(textContent(restored.doc)).toBe(literal);
    expect(
      restored.doc.content?.[0].content?.[0].marks?.map((mark) => mark.type),
    ).toEqual(text.marks?.map((mark) => mark.type));
    expect(
      [...restored.comments.values()].map((item) => [item.id, item.content]),
    ).toEqual([["c1", "Feedback"]]);
  });
}

for (const example of [
  "{==sample==}{>>example comment<<}{#c1}",
  '{==sample==}{>>example comment<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}',
]) {
  test(`source cleaning leaves an unflagged fenced review example literal: ${example}`, () => {
    const markdown = `* Keep source spelling\n\n\`\`\`md\n${example}\n\`\`\`\n`;
    expect(cleanRevisionSourceMarkdown(markdown)).toBe(markdown);
  });
}

test("generated code comment and reply bodies remain readable once through the shared review index", () => {
  const comments = new Map([
    [
      "c1",
      {
        id: "c1",
        content: "Code feedback",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    [
      "c2",
      {
        id: "c2",
        content: "Code reply",
        createdAt: "2026-01-01T00:01:00.000Z",
        parentCommentId: "c1",
      },
    ],
  ]);
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [
          {
            type: "text",
            text: "const count = 1;",
            marks: [
              { type: "commentRef", attrs: { commentIds: ["c1", "c2"] } },
            ],
          },
        ],
      },
    ],
  };
  const serialized = editorStateToCriticMarkdown(doc, comments);
  expect(serialized).toContain("codeAnchorEncoding: backslash");
  expect(validateRoughdraftMarkdown(serialized).ok).toBe(true);
  expect(
    extractRoughdraftReviewIndex(serialized).items.map((item) => [
      item.id,
      item.text,
      item.parentId,
    ]),
  ).toEqual([
    ["c1", "Code feedback", null],
    ["c2", "Code reply", "c1"],
  ]);
  const restored = criticMarkdownToEditorState(serialized);
  expect(textContent(restored.doc)).toBe("const count = 1;");
  expect(
    [...restored.comments.values()].map((item) => [
      item.id,
      item.content,
      item.parentCommentId,
    ]),
  ).toEqual([
    ["c1", "Code feedback", null],
    ["c2", "Code reply", "c1"],
  ]);
});

test("legacy code-annotation parsing remains an explicit option and preserves authored backslashes", () => {
  const literal = String.raw`C:\\notes\\file.md`;
  const markdown = `\`\`\`text\n{==${literal}==}{>>Legacy feedback<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}\n\`\`\`\n`;
  expect(criticMarkdownToEditorState(markdown).comments.size).toBe(0);
  const legacy = criticMarkdownToEditorState(markdown, {
    legacyCodeComments: true,
  });
  expect(textContent(legacy.doc)).toBe(literal);
  expect(legacy.comments.get("c1")?.content).toBe("Legacy feedback");
  const restored = criticMarkdownToEditorState(
    editorStateToCriticMarkdown(legacy.doc, legacy.comments),
  );
  expect(textContent(restored.doc)).toBe(literal);
  expect(restored.comments.get("c1")?.content).toBe("Legacy feedback");
});

test("a real code annotation does not opt unrelated same-ID fenced examples into review", () => {
  const real = String.raw`const marker = "==}"; // C:\\notes`;
  const compact = "{==sample==}{>>example comment<<}{#c1}";
  const attributes =
    '{==sample==}{>>example comment<<}{id="c1" by="user" at="2026-01-01T00:00:00.000Z"}';
  const block = (text: string, marked = false): JSONContent => ({
    type: "codeBlock",
    attrs: { language: "text" },
    content: [
      {
        type: "text",
        text,
        ...(marked
          ? { marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }] }
          : {}),
      },
    ],
  });
  const doc: JSONContent = {
    type: "doc",
    content: [block(real, true), block(compact), block(attributes)],
  };
  const serialized = editorStateToCriticMarkdown(
    doc,
    new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Actual code feedback",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]),
  );
  const cleaned = cleanRevisionSourceMarkdown(serialized);
  expect(cleaned).toContain(real);
  expect(cleaned).toContain(compact);
  expect(cleaned).toContain(attributes);
  expect(cleaned).not.toContain("Actual code feedback");
  expect(cleaned).not.toContain("codeAnchorEncoding");
  const restored = criticMarkdownToEditorState(serialized);
  expect(restored.doc.content?.map((node) => textContent(node))).toEqual([
    real,
    compact,
    attributes,
  ]);
  expect([...restored.comments.values()].map((item) => item.content)).toEqual([
    "Actual code feedback",
  ]);
});

test("editing a generated code comment's YAML body keeps its code anchor attached", () => {
  const code = String.raw`const marker = "==}"; // C:\\path`;
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [
          {
            type: "text",
            text: code,
            marks: [{ type: "commentRef", attrs: { commentIds: ["c1"] } }],
          },
        ],
      },
    ],
  };
  const serialized = editorStateToCriticMarkdown(
    doc,
    new Map([
      [
        "c1",
        {
          id: "c1",
          content: "Original feedback",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]),
  );
  const edited = serialized.replace(
    "body: Original feedback",
    "body: Updated feedback",
  );
  const restored = criticMarkdownToEditorState(edited);
  expect(textContent(restored.doc)).toBe(code);
  expect(restored.comments.get("c1")?.content).toBe("Updated feedback");
  expect(
    restored.doc.content?.[0].content?.[0].marks?.find(
      (mark) => mark.type === "commentRef",
    )?.attrs?.commentIds,
  ).toEqual(["c1"]);
});

test("a commented paragraph with a nested suggestion retains all surrounding formatted text", () => {
  const commentRef = { type: "commentRef", attrs: { commentIds: ["c1"] } };
  const bold = { type: "bold" };
  const change = {
    type: "criticChange",
    attrs: {
      kind: "addition",
      changeId: "s1",
      authorType: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const doc: JSONContent = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Alpha ", marks: [commentRef, bold] },
          { type: "text", text: "New ", marks: [commentRef, bold, change] },
          { type: "text", text: "beta", marks: [commentRef, bold] },
        ],
      },
    ],
  };
  const comments = new Map([
    [
      "c1",
      {
        id: "c1",
        content: "Keep this note.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  ]);
  const serialized = editorStateToCriticMarkdown(doc, comments);
  const restored = criticMarkdownToEditorState(serialized);
  expect(textContent(restored.doc)).toBe("Alpha New beta");
  const clean = criticMarkdownToEditorState(cleanRevisionMarkdown(serialized));
  expect(textContent(clean.doc)).toBe("Alpha beta");
  expect(
    clean.doc.content?.[0].content
      ?.filter((node) => node.text?.trim())
      .every((node) => node.marks?.some((mark) => mark.type === "bold")),
  ).toBe(true);
  expect(restored.comments.get("c1")?.content).toBe("Keep this note.");
  expect(
    restored.doc.content?.[0].content
      ?.filter((node) => node.text?.trim())
      .every((node) => node.marks?.some((mark) => mark.type === "bold")),
  ).toBe(true);
});
