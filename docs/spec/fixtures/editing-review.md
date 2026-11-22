---
title: Roughdraft editing and comment review
status: ready for review
owner: Product team
---

# Try Roughdraft's editing and comment fixes
This is a working release-plan document with real pending changes and comment threads. Your edits autosave to a separate practice copy; the repository examples stay intact.

Start with **Changes**, then compare **Original** and **Final**. Keep and Revert work on the examples below. Undo and Redo should restore both the document and its attached discussion. The prepared review also has two decisions in **History**.
## 1\. Dense edits in one paragraph
This paragraph differs from the original document in several nearby places. Its nearby edits should form one decision. Keep or Revert the whole group, then undo it.

For this release, use modernized and appropriately-sized machinery in the review lab. Keep the testing schedule stable and publish the approved result.
## 2\. Addition, deletion and replacement
The release supports {++offline review++}{#s1} for longer documents.

The announcement should omit {--a needless repeated introduction--}{#s2} before the main point.

We will describe the result as {~~a preliminary experiment~>an editing and review workspace~~}{#s3} for Markdown documents.

Try replying to the addition's thread before making another suggestion nearby.
## 3\. Overlapping and nested comments
Reply to either overlapping comment. Each should keep its own highlighted range, including the shared words and spaces. The first thread includes a reply and a nested reply.

The planting plan keeps {==red maple ==}{>>Keep the red maple and silver birch together. Edit or reply to this comment.<<}{#c1}{==and silver birch==}{>>Keep the red maple and silver birch together. Edit or reply to this comment.<<}{#c1}{>>This second comment overlaps the birch and continues to the path. Its highlight must stay separate.<<}{#c2}{== near the path==}{>>This second comment overlaps the birch and continues to the path. Its highlight must stay separate.<<}{#c2} for a sheltered entrance.

The next sentence has one comment inside another. Replying to the outer thread must not widen or erase the inner highlight.

The {==outer planning note includes ==}{>>Outer comment: preserve this entire sentence when replying.<<}{#c3}{==a nested decision==}{>>Outer comment: preserve this entire sentence when replying.<<}{#c3}{>>Inner comment: only these three words belong to my highlight.<<}{#c4}{== about the entrance.==}{>>Outer comment: preserve this entire sentence when replying.<<}{#c3}
## 4\. First click, full replacement and comment editing
Put the caret in the footer at the end of this document. Come back and click or tap the bold words once, then type. Your typing belongs at the clicked words.

Caret target: {==**bravo charlie**==}{>>Click or tap this bold phrase once, then type. The caret belongs where you clicked.<<}{#c5} stays in this paragraph.

Select every highlighted word below and type a replacement. Repeat with paste, then use Undo and Redo. The thread should follow the entire replacement, including every typed character.

Replace this complete selection: {==the original launch wording==}{>>Replace every highlighted word by typing or pasting; this comment should follow the complete replacement.<<}{#c7}. The rest of this sentence stays.

Open Edit on a comment: typing should work immediately. Save with Ctrl/Cmd+Enter or cancel with Escape. Try deleting a reply and restoring it with comment Undo.

The {==phone draft target==}{>>Use Edit on this comment. Type a draft, resize or unfold the screen, then press Escape to cancel.<<}{#c13} is useful for Save, Cancel and unfolding.
## 5\. One comment across formatting and paragraphs
Edit before, inside and after this highlight. Switch to Markdown and back, then refresh. It should remain one comment with the same complete range.

{==The first highlighted line has **bold emphasis** and ordinary words.==}{>>This one comment spans formatting and a paragraph boundary.<<}{#c6}

{==The same comment continues here==}{>>This one comment spans formatting and a paragraph boundary.<<}{#c6}, and stops before this ending.
## 6\. Multiline feedback and literal punctuation
Open this thread to see a multiline comment containing a closing marker and a suggestion example. Save or cancel an edit, then refresh. That punctuation must stay in the comment.

The {==multiline feedback example==}{>><<}{#c8} has punctuation that must remain inside its comment.

This paragraph contains literal text: \{++not a suggestion++\}, \{--not a deletion--\}, and \{\~\~old\~\>new\~\~}. These examples must remain ordinary document text.
## 7\. Formatting as a pending suggestion
The words are identical on both sides; only bold and italics change. Original and Final should show the correct formatting. Keep or Revert the whole formatting proposal.

{~~
The launch guide uses a clear title and a short summary.
~>
The launch guide uses a **clear title** and a *short summary*.
~~}{#s4}
## 8\. Paragraphs, lists and pasted blocks
Keep or Revert this paragraph split. Then use Suggest yourself: place the caret between two words and press Enter or Shift+Enter. Backspace at the start of the next paragraph should join it back. Repeat after an earlier Keep decision and a Markdown round trip.

{~~
The team reviews the draft. The team publishes after approval.
~>
The team reviews the draft.

The team publishes after approval.
~~}{#s5}

The list proposal adds nested items. Also try continuing a list with Enter, indenting with Tab, and outdenting with Shift+Tab.

{~~
- Draft the release plan.
- Invite reviewers.
- Publish the approved result.
~>
- Draft the release plan.
  
  - Add a phone review.
  - Check the unfolded layout.
- Invite reviewers.
- Publish the approved result.
~~}{#s6}

The next proposal pastes several paragraphs and a list as one change. Try selecting across two blocks and using Cut, paste or Enter.

{~~
The release checklist is written as one short paragraph.
~>
The release checklist starts with a summary.

- Verify the accepted text.
- Keep comments attached.

The team signs off after review.
~~}{#s12}
## 9\. Code, whitespace and code comments
This code change already includes an attached comment, indentation, a blank line, literal review markers and a final empty line. Keep and Revert should preserve the chosen code exactly.

{~~
```js
{==function review(draft) \{
	const example = "\{++literal example++\}";

  return draft;
\}
==}{>><<}{#c10}
```
~>
```js
{==function review(draft) \{
	const example = "\{++literal example++\}";

  return draft.trimEnd();
\}
==}{>><<}{#c10}
```
~~}{#s7}

Type into the proposed code in Suggest, refresh, and continue typing. It must remain a pending change until Keep.

The annotated command is {==`roughdraft edit ./draft.md`==}{>><<}{#c14}.

The fenced examples below are literal code and must never create extra comments or suggestions:

````markdown
{==literal highlight==}{>>literal comment<<}{#not-a-real-comment}
{++literal addition++} {--literal deletion--} {~~old~>new~~}

```text
An inner triple fence stays inside this four-fence example.
```
````

The final empty line in this plain code example should survive editing and refresh:

```text
alpha
  beta

```
## 10\. Headings, quotations and images
This replacement changes a heading and a block quote together. Original and Final must show real block structure, not exposed review markers.

{~~
### Initial rollout
> Publish to everyone immediately.
~>
### Staged rollout
> Review on desktop and phone before publishing.
~~}{#s8}

The next proposal replaces one local image with another. Both images are bundled with the review.

{~~
![Original: a plain document](./editing-review-assets/original.svg)
~>
![Proposed: a document with comments](./editing-review-assets/reviewed.svg)
~~}{#s9}

Select this separate image and press Delete or type over it in Suggest. Revert must bring it back; Keep must remove or replace it.

![Image selection practice: document with a review rail](./editing-review-assets/reviewed.svg)
## 11\. Tables, tasks and soft line breaks
Edit a table cell and move between cells. Add a comment to part of a cell and check it after refresh.

| Review area | Owner | Expected result |
| --- | --- | --- |
| Document text | Product | Clear, readable paragraphs |
| Comments | Review team | Attached to the intended words |
| Phone layout | Design | Readable without horizontal scrolling |

- [x] 
  
  Prepare the practice document.
- [ ] 
  
  Review the accepted outcome.
- [ ] 
  
  Check comments after refresh.

This is the first line of one paragraph.  
This second line follows a soft line break. Try Backspace at its start in Suggest.
## 12\. Links, endnotes and navigation
Edit this [Roughdraft setup link](https://roughdraft.md/setup.md). Try a comment on its label. This release note has an endnote[^review] and repeats the same reference here[^review].

Open the endnote preview and its local link, or follow the [linked review note](./editing-review-linked.md). Pending edits and comments should be preserved before navigation. Use your browser's Back button to return to this saved review and its choices.
## 13\. Unicode and keyboard composition
Delete one whole emoji at a time, undo it, and try typing with your usual keyboard in Edit and Suggest. Composing text should not create a new suggestion for each unfinished character.

Café, café, 中文, 日本語, 한국어 — 👩‍👩‍👧‍👦 👨🏽‍💻 🇺🇸 🦋.
## 14\. History and scrolling
This section supplies a Keep example and a Revert example. In a fresh copy, Keep the first suggestion and Revert the second. The shared review has already done that so History is ready to try.

History Keep example: the release notes are {++deliberately clear++}{#s10}.

History Revert example: we {--keep the comment history--}{#s11} alongside the document.

Scroll to another section, open History and undo one of these decisions. The document should scroll back to the affected passage. Then try a new paragraph suggestion, Undo/Redo, and refresh.
## 15\. Phone, folding and saved review state
Start editing the phone-draft comment above, leave the textarea open, then resize or unfold. The text, focus and draft should survive. Cancel should restore the original feedback. Try both a narrow screen and a short viewport with the keyboard open.

Switch between Changes, Original, Final and Markdown while reviewing. Copy and Download should match the visible clean outcome; the full Markdown view keeps the discussion and pending suggestions. Refresh should retain your review choices and comments.
## Footer caret target
Footer stays unchanged when you click and type inside an earlier comment.

[^review]: A **reviewed release** keeps comments attached and accepted text separate from pending suggestions.

    This second endnote paragraph links to the [companion note](editing-review-linked.md).

---
comments:
  c1:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c2:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c3:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c4:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c5:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c6:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c7:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c8:
    by: user
    at: 2026-11-22T12:00:00.000Z
    body: |-
      First line of a multiline comment.
      Literal closing marker: <<}
      Literal suggestion example: {++this stays comment text++}
  c9:
    by: user
    at: 2026-11-22T12:00:00.000Z
    body: "Reply: I agree; keep both trees in the same paragraph."
    re: c1
  c10:
    by: user
    at: 2026-11-22T12:00:00.000Z
    codeAnchorEncoding: backslash
    body: Preserve the indentation, blank lines, literal braces and final empty code
      line.
  c11:
    by: user
    at: 2026-11-22T12:00:00.000Z
    body: "Reply on a pending suggestion: this discussion should stay attached
      through further edits and decisions."
    re: s1
  c12:
    by: user
    at: 2026-11-22T12:00:00.000Z
    body: "Nested reply: this message belongs to the reply above."
    re: c9
  c13:
    by: user
    at: 2026-11-22T12:00:00.000Z
  c14:
    by: user
    at: 2026-11-22T12:00:00.000Z
    codeAnchorEncoding: backslash
    body: An inline-code comment must survive without changing the command.
suggestions:
  s1:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s2:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s3:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s4:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s5:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s6:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s12:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s7:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s8:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s9:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s10:
    by: AI
    at: 2026-11-22T12:00:00.000Z
  s11:
    by: AI
    at: 2026-11-22T12:00:00.000Z
