# Roughdraft Flavored Markdown 0.2

Status: Draft

Roughdraft Flavored Markdown is regular Markdown plus a portable review layer based on CriticMarkup. Its purpose is to let people and coding agents exchange comments, threaded replies, and pending changes inside the Markdown file itself.

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" in this document are to be interpreted as described in RFC 2119.

## Scope

This specification defines the review markup that Roughdraft reads and writes. It does not define a replacement for Markdown, a hosted document format, a sync protocol, or a project database.

A conforming document is a Markdown document that may contain Roughdraft review spans. Markdown parsing SHOULD follow CommonMark with GitHub Flavored Markdown extensions. Implementations MAY preserve YAML frontmatter as document metadata. Roughdraft review state lives in the same Markdown file, either as inline review anchors or as final YAML endmatter.

## Canonical Markers

Roughdraft uses these CriticMarkup-compatible markers:

```markdown
{>>comment<<}
{++inserted text++}
{--deleted text--}
{~~old text~>new text~~}
{==highlighted text==}
```

An implementation MUST treat the opening and closing marker pairs as review delimiters outside inline code and fenced code blocks.

Implementations MUST treat review markers inside inline code spans and fenced code blocks as literal example text by default. Code annotations require the explicit metadata extension described below.

## Comments

A comment is written as:

```ebnf
comment = "{>>" comment-text "<<}" [ metadata ]
```

Comment text is plain inline Markdown content. Comment text MUST NOT contain the literal closing delimiter `<<}` unless the implementation defines an escaping extension. Writers that do not implement escaping MUST reject comment or reply text containing raw CriticMarkup close delimiters instead of emitting ambiguous review markup.

A comment MAY appear by itself when the feedback applies to the surrounding paragraph or document:

```markdown
Add one concrete launch example here.{>>This should come from the customer story.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

## Anchored Comments

An anchored comment is a highlight immediately followed by one or more comment blocks:

```ebnf
anchored-comment = highlight 1*comment
highlight        = "{==" anchor-text "==}"
```

Example:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

The highlighted text is the visible anchor. Implementations SHOULD attach all immediately following comment blocks to the same anchor until another token interrupts the sequence.

A standalone highlight is valid CriticMarkup. Roughdraft 0.1 reserves it as review syntax, but standalone highlights are not required to produce a review-thread item unless an implementation explicitly supports highlight-only annotations.

### Code annotations

To annotate code without confusing its literal contents with review delimiters, the editor writes an empty inline comment, `{>><<}{#id}`, and a corresponding YAML comment entry with `codeAnchorEncoding: backslash`. The comment's body lives only in that YAML entry. Within that comment's code anchor, each backslash and brace is escaped with a backslash. Readers supporting this extension decode only those declared code anchors; they MUST NOT apply that decoding to ordinary code or unflagged historical input.

The YAML entry also contains the comment's `body`, so readers that treat all code as literal can still return the feedback. An implementation MAY offer an explicit compatibility mode for historical unflagged code annotations. New writers MUST use the declaration rather than infer annotations from code examples.

### Frontmatter annotations

Frontmatter fields support comments and suggestions while retaining their literal YAML spelling. Review syntax inside frontmatter is literal by default. To identify actual feedback, its entry under final `comments:` or `suggestions:` MUST declare `frontmatterAnchor: true`. Readers MUST NOT reinterpret unregistered examples as feedback. Writers MUST allocate IDs that do not collide with literal review references already in the header.

```markdown
---
title: {~~Working draft~>Release plan~~}{#s1}
owner: {==Product team==}{>><<}{#c1}
---

Document body.

---
comments:
  c1:
    body: Please confirm the owner.
    by: AI
    at: "2026-11-28T00:00:00.000Z"
    frontmatterAnchor: true
    codeAnchorEncoding: backslash
suggestions:
  s1:
    by: AI
    at: "2026-11-28T00:00:00.000Z"
    frontmatterAnchor: true
```

Generated frontmatter comment anchors use the declared `codeAnchorEncoding: backslash` extension above. For proposed literal text, the editor declares `literalChangeEncoding: backslash` on the suggestion entry and escapes backslashes, braces and the `~>` delimiter inside its payload. Readers decode those declared payloads once, without parsing the decoded text as more review syntax. Preserve these declarations when editing existing feedback. Accepted file content excludes pending proposals and review metadata; YAML field order, quoting and line endings remain unchanged unless edited.

## Suggestions

Suggestions represent pending edits. Implementations MUST NOT silently collapse suggestions into normal prose while reading or writing Roughdraft Flavored Markdown.

### Insertion

```ebnf
addition = "{++" new-text "++}" [ metadata ] *comment
```

```markdown
Add {++one concrete example++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

### Deletion

```ebnf
deletion = "{--" old-text "--}" [ metadata ] *comment
```

```markdown
Remove {--vague phrasing--}{#s2}.

---
suggestions:
  s2:
    by: user
    at: "2026-04-28T12:06:00.000Z"
```

### Substitution

```ebnf
substitution = "{~~" old-text "~>" new-text "~~}" [ metadata ] *comment
```

```markdown
Use {~~rough~>specific~~}{#s3} wording.

---
suggestions:
  s3:
    by: AI
    at: "2026-04-28T12:07:00.000Z"
```

Trailing comment blocks after a suggestion attach discussion to that suggestion:

```markdown
Add {++one concrete example++}{#s1}.

---
comments:
  c2:
    body: Use the launch story.
    by: user
    at: "2026-04-28T12:08:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

## Metadata

Roughdraft's preferred metadata format is a compact inline reference backed by final YAML endmatter:

```ebnf
reference = "{#" id "}"
id        = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Root comment bodies and suggestion text normally stay inline so their anchors remain portable. A multiline comment or a body containing `<<}` uses an empty inline comment, `{>><<}{#c1}`, with its text in the YAML `body` field. Readers hydrate that empty comment from the referenced body. Replies live entirely in endmatter because their `re` field already points at a parent id:

```markdown
Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

Suggested-change metadata lives under `suggestions:`:

```markdown
Add {++one concrete example++}{#s1}.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```

For compatibility, readers also accept the older inline attribute block written immediately after a comment or suggestion:

```ebnf
metadata  = "{" 1*attribute "}"
attribute = name "=" quoted-value
name      = ALPHA *( ALPHA / DIGIT / "_" / "-" )
```

Attribute values are double-quoted strings. Inside a quoted value, `\"` represents a literal quote and `\\` represents a literal backslash.

Known metadata attributes:

| Attribute | Applies to | Required when writing | Meaning |
| --- | --- | --- | --- |
| `id` | Comments and suggestions | Yes | Stable document-local identifier. |
| `by` | Comments and suggestions | Yes | Author or agent label. `AI` identifies an agent author. |
| `at` | Comments and suggestions | Yes | ISO 8601 timestamp. |
| `re` | Comments | No | Parent comment or suggestion id for threaded replies. |
| `status` | Comments and suggestions | No | Review state. Roughdraft currently writes `resolved` when an item has been addressed. |
| `resolved` | Comments and suggestions | No | Optional short resolution summary for an item whose `status` is `resolved`. |
| `codeAnchorEncoding` | YAML comment entries | For generated code annotations | `backslash` explicitly identifies encoded code anchors; their feedback also appears in `body`. |
| `frontmatterAnchor` | YAML comment and suggestion entries | For frontmatter annotations | `true` distinguishes review feedback from literal YAML examples. |
| `literalChangeEncoding` | YAML suggestion entries | For generated literal YAML proposals | `backslash` identifies an escaped literal payload, decoded once. |

Example:

```markdown
{>>Needs a source.<<}{#c1}

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
```

Implementations SHOULD generate simple document-local ids. Roughdraft uses `c1`, `c2`, and so on for comments and `s1`, `s2`, and so on for suggestions. Implementations MUST preserve unknown valid attributes or YAML keys when possible, but they MUST NOT require unknown metadata for correct review rendering.

Multiple compact references MAY identify separate fragments of one logical comment, such as overlapping or differently formatted text. Readers SHOULD index that comment once while retaining all its anchor fragments. Repeated inline declarations or conflicting bodies for the same id remain errors.

For compatibility, readers MAY accept legacy comment metadata of the form `{@id:c1; by:AI; at:2026-04-28T12:00:00.000Z@}`. Writers SHOULD emit compact references plus YAML endmatter for new review data.

## Threads

Threading is represented by `re`.

```markdown
Review {==this sentence==}{>>Needs a source.<<}{#c1}.

---
comments:
  c1:
    by: user
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can add one from the intro.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
```

A reply whose `re` points to a missing id SHOULD be treated as a top-level comment. A comment MUST NOT be its own parent.

## Parsing And Round Trips

Implementations SHOULD parse Roughdraft review markers as inline review annotations without rewriting unrelated Markdown.

Round trips SHOULD preserve:

- YAML frontmatter delimiters and content.
- Local links and image paths.
- Tables and task lists.
- Inline code and fenced code blocks.
- Raw review marker text inside code contexts.
- Metadata values, including escaped quotes and backslashes.

When importing a valid comment or suggestion without metadata, an implementation MAY synthesize missing `id`, `by`, and `at` values on write.

## Review Interchange JSON

The Markdown file is the normative storage format. For APIs, tests, and integrations, implementations MAY expose a review index JSON document that follows [`roughdraft-flavored-markdown.schema.json`](./roughdraft-flavored-markdown.schema.json).

The review index intentionally does not replace a Markdown AST. It indexes Roughdraft review annotations while leaving block parsing to the Markdown implementation.

Example:

```json
{
  "format": "roughdraft-flavored-markdown",
  "version": "0.1",
  "source": {
    "markdown": "Please revisit {==this sentence==}{>>Needs a source.<<}{#c1}.\\n\\n---\\ncomments:\\n  c1:\\n    by: user\\n    at: \"2026-04-28T12:00:00.000Z\"\\n"
  },
  "comments": [
    {
      "id": "c1",
      "body": "Needs a source.",
      "by": "user",
      "at": "2026-04-28T12:00:00.000Z",
      "anchor": {
        "text": "this sentence"
      }
    }
  ],
  "suggestions": []
}
```

Conformance fixtures live in [`fixtures/`](./fixtures/). A parser that claims Roughdraft Flavored Markdown 0.1 support SHOULD pass those examples or document any intentional differences.
