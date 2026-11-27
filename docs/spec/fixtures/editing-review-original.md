---
title: Roughdraft editing and comment review
status: draft
owner: Product team
---

# Try Roughdraft's editing and comment fixes
This is a working release-plan document with real pending changes and comment threads. Your edits autosave to a separate practice copy; the repository examples stay intact.

Start with **Changes**, then compare **Original** and **Final**. Keep and Revert work on the examples below. Undo and Redo should restore both the document and its attached discussion. The prepared review also has two decisions in **History**.
## 1\. Dense edits in one paragraph
This paragraph differs from the original document in several nearby places. Its nearby edits should form one decision. Keep or Revert the whole group, then undo it.

For this release, use outdated and undersized equipment in the review lab. Keep the testing schedule stable and publish the approved result.
## 2\. Addition, deletion and replacement
The release supports for longer documents.

The announcement should omit a needless repeated introduction before the main point.

We will describe the result as a preliminary experiment for Markdown documents.

Try replying to the addition's thread before making another suggestion nearby.
## 3\. Overlapping and nested comments
Reply to either overlapping comment. Each should keep its own highlighted range, including the shared words and spaces. The first thread includes a reply and a nested reply.

The planting plan keeps red maple and silver birch near the path for a sheltered entrance.

The next sentence has one comment inside another. Replying to the outer thread must not widen or erase the inner highlight.

The outer planning note includes a nested decision about the entrance.
## 4\. First click, full replacement and comment editing
Put the caret in the footer at the end of this document. Come back and click or tap the bold words once, then type. Your typing belongs at the clicked words.

Caret target: **bravo charlie** stays in this paragraph.

Select every highlighted word below and type a replacement. Repeat with paste, then use Undo and Redo. The thread should follow the entire replacement, including every typed character.

Replace this complete selection: the original launch wording. The rest of this sentence stays.

Open Edit on a comment: typing should work immediately. Save with Ctrl/Cmd+Enter or cancel with Escape. Try deleting a reply and restoring it with comment Undo.

The phone draft target is useful for Save, Cancel and unfolding.
## 5\. One comment across formatting and paragraphs
Edit before, inside and after this highlight. Switch to Markdown and back, then refresh. It should remain one comment with the same complete range.

The first highlighted line has **bold emphasis** and ordinary words.

The same comment continues here, and stops before this ending.
## 6\. Multiline feedback and literal punctuation
Open this thread to see a multiline comment containing a closing marker and a suggestion example. Save or cancel an edit, then refresh. That punctuation must stay in the comment.

The multiline feedback example has punctuation that must remain inside its comment.

This paragraph contains literal text: \{++not a suggestion++\}, \{--not a deletion--\}, and \{\~\~old\~\>new\~\~}. These examples must remain ordinary document text.
## 7\. Formatting as a pending suggestion
The words are identical on both sides; only bold and italics change. Original and Final should show the correct formatting. Keep or Revert the whole formatting proposal.

The launch guide uses a clear title and a short summary.
## 8\. Paragraphs, lists and pasted blocks
Keep or Revert this paragraph split. Then use Suggest yourself: place the caret between two words and press Enter or Shift+Enter. Backspace at the start of the next paragraph should join it back. Repeat after an earlier Keep decision and a Markdown round trip.

The team reviews the draft. The team publishes after approval.

The list proposal adds nested items. Also try continuing a list with Enter, indenting with Tab, and outdenting with Shift+Tab.

- Draft the release plan.
- Invite reviewers.
- Publish the approved result.

The next proposal pastes several paragraphs and a list as one change. Try selecting across two blocks and using Cut, paste or Enter.

The release checklist is written as one short paragraph.
## 9\. Code, whitespace and code comments
This code change already includes an attached comment, indentation, a blank line, literal review markers and a final empty line. Keep and Revert should preserve the chosen code exactly.

```js
function review(draft) {
	const example = "{++literal example++}";

  return draft;
}

```

Type into the proposed code in Suggest, refresh, and continue typing. It must remain a pending change until Keep.

The annotated command is `roughdraft edit ./draft.md`.

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
### Initial rollout
> Publish to everyone immediately.

The next proposal replaces one local image with another. Both images are bundled with the review.

![Original: a plain document](./editing-review-assets/original.svg)

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

History Keep example: the release notes are .

History Revert example: we keep the comment history alongside the document.

Scroll to another section, open History and undo one of these decisions. The document should scroll back to the affected passage. Then try a new paragraph suggestion, Undo/Redo, and refresh.
## 15\. Phone, folding and saved review state
Start editing the phone-draft comment above, leave the textarea open, then resize or unfold. The text, focus and draft should survive. Cancel should restore the original feedback. Try both a narrow screen and a short viewport with the keyboard open. When unfolded, toolbar actions should be visible whenever they fit; fold the screen to check that More appears only when needed.

Switch between Changes, Original, Final and Markdown while reviewing. Copy and Download should match the visible clean outcome; the full Markdown view keeps the discussion and pending suggestions. Refresh should retain your review choices and comments.
## 16\. Live updates and conflict recovery
Open this same review in a second tab. Edit the first practice paragraph in one tab and the second in the other. Both edits should appear together without interrupting your typing or resetting Undo.

Practice paragraph one: keep the planting schedule steady while the entrance review continues.

Practice paragraph two: keep the lighting schedule steady while the release review continues.

Next, change the same word in both tabs. Compare changes should show both versions. Discard my changes uses the latest overlapping wording; Overwrite with my changes uses yours. Both keep unrelated edits and discussions.

Try Save separately while viewing Changes, Original and Final. It saves the working draft each time. The dialog starts with an unused path, and the success popup shows the actual saved path and new review link. Keep the copy beside this document to preserve its images and linked notes, or inspect the relative-link warning before choosing another folder.

Have the agent change a practice copy on disk while you read, and again while you type in the other paragraph. Saved comments and displaced suggestions must remain available. Reopen an earlier History decision after the outside edit and verify the restored passage is the one you selected.

## Footer caret target
Footer stays unchanged when you click and type inside an earlier comment.

[^review]: A **reviewed release** keeps comments attached and accepted text separate from pending suggestions.

    This second endnote paragraph links to the [companion note](editing-review-linked.md).
