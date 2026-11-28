# Roughdraft UI State Screenshot Guide
This file is a reusable checklist for capturing Roughdraft's major UI states. It is meant to support periodic visual review, not to replace automated tests.
## Screenshot Folder Convention
Put each run in a timestamped directory:

```bash
mkdir -p .context/ui-state-screenshots/$(date +%Y%m%d-%H%M%S)
```

Use filenames that sort by product area, viewport, and state:

```text
01-home-desktop.png
01-home-mobile.png
02-home-install-dialog.png
03-home-workflow-stage-1.png
04-preview-rich-review-rail.png
```
## Starting The App
For route-only states, the Vite app is enough:

```bash
pnpm --filter @roughdraft/app dev -- --host 127.0.0.1 --port 5173
```

Useful URLs:

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/roughdraft-flavored-markdown
http://127.0.0.1:5173/preview
http://127.0.0.1:5173/preview?editor=code
http://127.0.0.1:5173/preview?editor=rich-text
```

For local file backend states, use the worktree-specific CLI wrapper:

```bash
worktree_root="$(git rev-parse --show-toplevel)"
worktree_name="$(basename "$worktree_root")"
roughdraft_cmd="roughdraft-dev-$worktree_name"

command -v "$roughdraft_cmd" >/dev/null || pnpm dev:install-cli
"$roughdraft_cmd" start
"$roughdraft_cmd" open "$worktree_root/.context/ui-state-fixtures/review.md" --print-url --no-open --no-watch
```
## Fixture Documents
Create these under `.context/ui-state-fixtures/` when a capture run needs stable local-file states.
### Plain Document
```markdown
# Plain document
Paragraph with **bold**, [link](https://example.com), `inline code`.

- [ ] Task
- [x] Done

| Area | Status |
| --- | --- |
| Intro | Draft |
```
### Review Document
```markdown
# Review document {==Select this sentence==}{>>Root comment<<}{#root} This sentence includes {++clearer wording++}{#s1}. Replace {~~old phrase~>new phrase~~}{#s2} and remove {--dead text--}{#s3}.

---
comments:
  root:
    by: Nora
    at: "2026-04-28T12:00:00.000Z"
  child:
    body: Nested reply
    by: AI
    at: "2026-04-28T12:01:00.000Z"
    re: root
  c1:
    body: Looks good.
    by: Nora
    at: "2026-04-28T12:03:00.000Z"
    re: s1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:02:00.000Z"
  s2:
    by: AI
    at: "2026-04-28T12:04:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:05:00.000Z"
```
### Fenced CriticMarkup Document
```markdown
# Fenced examples This page should not show a review rail just because examples appear inside code fences. ```text {==example==}{>>comment<<}{#c1} {++inserted++} {--deleted--} {~~old~>new~~} ```
```
## Capture Matrix
| Area | State | How to reach it | Useful selectors | Notes |
| --- | --- | --- | --- | --- |
| App shell | Initial loading | Load any route and capture before backend initialization completes, usually with a route/mock delay | none | Transient; easiest in a mocked route or component harness. |
| Homepage | Desktop | `/` at desktop viewport | `homepage-workflow-storyboard` | Capture first viewport and a lower scroll position where the storyboard is active. |
| Homepage | Mobile | `/` at mobile viewport | `homepage-workflow-storyboard`, `homepage-workflow-scene-list` | Sticky visual is hidden until the workflow heading has scrolled past. |
| Homepage | Install dialog | Click the install CTA | Base UI dialog content | Include the terminal command and close affordance. |
| Homepage | Workflow stage 1 | Scroll storyboard to first scene | `homepage-workflow-terminal`, `homepage-workflow-scene` | User request visible; agent work and popup are hidden. |
| Homepage | Workflow stage 2 | Scroll to second scene | `homepage-workflow-agent-work` | Agent work becomes visible. |
| Homepage | Workflow stage 3 | Scroll to third scene | `homepage-workflow-terminal-command`, `homepage-workflow-popup` | Roughdraft command and document popup are visible. |
| Homepage | Workflow stage 4 | Scroll to fourth scene | `homepage-workflow-review-rail`, `homepage-workflow-comment-highlight` | User feedback appears in the document/review rail. |
| Homepage | Workflow stage 5 | Scroll to fifth scene | `homepage-workflow-handoff-button` | Done handoff button is visible. |
| Homepage | Workflow stage 6 | Scroll to final scene | `homepage-workflow-agent-resume` | Agent resume line and incorporated plan are visible; done button is hidden. |
| Homepage | Update notice | Start app with backend status returning `updateStatus` | update notice component | Best captured with API mocking unless an update is actually available. |
| RFM guide | Default page | `/roughdraft-flavored-markdown` | `rfm-source-editor` | Capture the source editor plus rendered output. |
| RFM guide | Plan review example | Click `rfm-format-example-plan-review` | `rfm-format-example-plan-review` | Default example if already selected. |
| RFM guide | Spec review example | Click `rfm-format-example-spec-review` | `rfm-format-example-spec-review` | Confirms comments/suggestions render in the embedded demo. |
| RFM guide | Writing edit example | Click `rfm-format-example-writing-edit` | `rfm-format-example-writing-edit` | Useful for prose-focused review states. |
| Preview | Rich text default | `/preview?editor=rich-text` | `page-card-rich-text`, `rich-text-editor` | Uses in-memory preview backend and includes a sample anchored comment. |
| Preview | Code editor default | `/preview?editor=code` | `page-card-code`, `markdown-code-editor` | Capture line wrapping, code editor chrome, and rail behavior. |
| Document | Rich/code toggle | Use `document-editor-view-toggle` | `document-editor-view-toggle` | URL changes to `?editor=code` or `?editor=rich-text`. |
| Document | Editing mode | Open mode menu and choose Editing | `document-mode-trigger` | Normal edit behavior. |
| Document | Suggesting mode | Open mode menu and choose Suggesting | `document-mode-trigger` | Selection actions should create suggestions instead of direct edits. |
| Document | Viewing mode | Edit in code mode, switch to Viewing, then back to Editing | `document-mode-trigger`, `markdown-code-editor` | Capture the unchanged draft and selection; changing editability must preserve content and history. |
| Document | Save status: saved | Any clean document after autosave | `document-save-status` | Checkmark should sit fixed in the top-left corner and fade out over 2 seconds; accessible label remains `Saved`. |
| Document | Save status: unsaved | Type in a local document before save completes | `document-save-status` | Spinner-only pending state; accessible label is `Unsaved changes`. Transient; often easier with save throttling or network mocking. |
| Document | Save status: saving | Type and capture during autosave | `document-save-status` | Spinner-only pending state; accessible label is `Saving`. Transient; easiest with mocked delayed save. |
| Document | Save status: failed | Force save error | `document-save-status` | Icon-only error state; accessible label is `Save failed`. Use backend/API mocking or a component harness. |
| Document | Disk changed | Open local file, modify file externally while browser content is clean | `file-conflict-notice`, `file-conflict-action-reload`, `file-conflict-action-overwrite` | Banner title: `File changed on disk`. |
| Document | Save conflict | Edit in browser, then modify file externally before autosave resolves | `file-conflict-notice`, `file-conflict-action-keep-editing`, `document-save-status-corner` | Banner title: `Save conflict`; autosave pauses. Capture narrow and unfolded widths: the save icon moves to the bottom-left and must not overlap the banner. |
| Document | Autosave paused | Keep editing after conflict | `file-conflict-notice`, `file-conflict-action-overwrite` | Banner title: `Autosave paused`; no keep-editing action. |
| Document | Review handoff idle | Open a local file while a watcher is connected | `review-handoff-button` | Header text: `Agent watching`. |
| Document | Review handoff comment popover | Open a local file while a watcher is connected, then click the handoff dropdown trigger | `review-handoff-comment-trigger`, `review-handoff-comment-popover`, `review-handoff-overall-comment` | Capture the split handoff control and textarea with `Overall comment` placeholder before submission. |
| Document | Review handoff sending | Click handoff button while watcher is connected | `review-handoff-button` | Button label: `Sending`. |
| Document | Review handoff sent | Successful handoff | `review-handoff-status`, `review-handoff-robots-toy`, `review-handoff-close-window`, `review-handoff-copy-message` | Capture the random completion title, robot toy, primary close button, and fallback copy hint below it. |
| Document | Review handoff undelivered | Watcher disconnects before handoff | `review-handoff-status` | Popover title: `No agent is watching now`. |
| Document | Review handoff error | Force handoff API error | `review-handoff-status` | Popover title: `Could not notify agent`. |
| Remote | Connected banner | Open with `?session=<id>&token=<token>` and remote capability enabled | `remote-session-connected` | The session URL needs no local path parameter; capture the loaded document workspace. |
| Remote | Disconnected banner | Close the source CLI while leaving the viewer open | `remote-session-disconnected` | The custom disconnect event must show the warning even while the viewer's event stream stays open. |
| Editor | Selection menu | Select text in rich editor | `selection-menu` | Capture formatting buttons and comment/suggestion actions. |
| Editor | Selection menu on suggestion | Select existing suggestion text | `selection-menu-action-accept-suggestion`, `selection-menu-action-reject-suggestion` | Requires review fixture. |
| Editor | Link popover | Click a link or choose Link from selection menu | `link-popover`, `link-url-input`, `link-action-open`, `link-action-delete` | Use the plain fixture link. |
| Editor | Context menu | Right-click in rich editor | `editor-context-menu` | Capture comment, suggestion, paste, and paste-markdown actions. |
| Review rail | Comments | Open review fixture in rich mode | `document-review-rail`, `comment-thread-root` | Thread containers use `data-comment-thread-container="true"`. |
| Review rail | Suggestions | Open review fixture in rich mode | `suggestion-thread-s1`, `suggestion-thread-s2`, `suggestion-thread-s3`, `document-accept-all`, `document-reject-all` | Capture the bulk buttons and the shortcut hints on individual actions. Thread containers use `data-suggestion-thread-container="true"`. |
| Review rail | Suggestion across blocks | Open one replacement containing two paragraphs, a heading and a feature list on each side | `suggestion-thread-s24`, `comment-rail-s24-action-accept`, `comment-rail-s24-action-reject` | Capture complete old/new block structure and one shared suggestion card. Accept/Reject must keep only the chosen blocks after save and reload. |
| Review rail | Draft suggestion | Select text and choose a suggestion action | `draft-suggestion-thread`, `draft-suggestion-editor` | Capture dismiss/cancel/apply actions. |
| Comment editor | New root comment draft | Select text and choose Add comment | `comment-rail-c1-editor`, `comment-rail-c1-action-save` | Save uses the popover-style button; footer Cancel is absent because the thread trash action dismisses the draft. |
| Comment editor | Root comment editing | Use a comment card edit action | `comment-rail-root-editor` | The textarea receives focus immediately, with the caret at the end. Type without an extra click, save with Ctrl/Cmd+Enter, and cancel with Escape. Check desktop and phone widths. Comment test IDs follow `comment-${variant}-${id}-...`. |
| Comment editor | Reply editing | Use a reply action | `comment-rail-child-editor` | Useful for nested thread spacing. |
| Code mode | Review rail present | Open review fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms code editor and rail can coexist. |
| Code mode | Review rail absent | Open fenced fixture with `?editor=code` | `page-card-code`, `markdown-code-editor` | Confirms fenced CriticMarkup alone does not create review rail. |
| Error/home fallback | Non-Markdown path | Open URL with `?path=/tmp/file.txt` | homepage error message | Copy: `Roughdraft now opens one .md file at a time.` |
| Error/home fallback | Missing/unloadable path | Open URL with invalid markdown path through local backend | homepage error message | Captures load-error homepage variant. |
## File Comparison States

Create a record with `roughdraft propose`, `roughdraft review`, or `roughdraft compare`, then open the printed `/?comparison=<id>` URL. Comparisons use the same rendered Markdown editor, native change highlights, and suggestion/comment rail as ordinary Roughdraft files. The rendered body is read-only; decisions and comments save separately, and only the final action can write the destination. Capture both desktop and mobile.

| State | Setup | Stable selectors | What to capture |
| --- | --- | --- | --- |
| Compact review header | Scroll a long comparison | `comparison-header`, `comparison-header-filename`, `comparison-header-state` | Full-width header stays at the page top; full destination path wraps visibly, with mode, remaining decisions, save/conflict state and one explicit primary action. A comparison without a destination shows both labeled version paths. |
| Change navigation | Use Previous / Next in a long comparison | `comparison-previous-change`, `comparison-next-change`, `comparison-navigation-position` | Native change anchors land below the sticky header. Reviewed changes become navigable when Show reviewed changes is selected. |
| Mobile header | Open a long path at 390px wide | `comparison-header`, `comparison-remaining`, `comparison-apply` | Full visible path wraps above compact controls, including the version selector and final action, with no page overflow. |
| Original and selected preview | Select Before, then After | `comparison-view-before`, `comparison-view-after`, `comparison-clean-preview` | Before is frozen; After reflects current choices with pending changes using the new version. No separate Result button or inline explanation. Meanings are in tooltips. Reading column and heading spacing remain stable. |
| Version round trips | Read a changed/deleted passage and cycle Before / Diff / After in normal motion | `comparison-view-before`, `comparison-view-diff`, `comparison-view-after` | No transient flash to the top. Returning restores the original passage even if it was absent in another view. The top stays at zero; x/width and unchanged title y remain stable. Actual reader scrolling selects a new passage. Drafts survive. |
| Literal Markdown comparison | Click Markdown in each version view | `comparison-formatted`, `comparison-view-selector` | Literal Markdown syntax in a monospace read-only document, with the same native change highlights and review controls. Formatted returns to rendered headings/lists. Both controls preserve the reading passage; neither saves choices or writes source. |
| Proposed changes, undecided | Create proposal | `comparison-mode`, `document-review-rail`, `comparison-apply` | Native suggestion cards with Accept / Skip; disabled Apply until every source change is decided; destination and save explanation. |
| Proposed changes, mixed choices | Accept one and Skip another | `comment-rail-<id>-action-accept`, `comment-rail-<id>-action-reject`, `comparison-save-status` | Resolved choices display their selected content. Show reviewed changes reveals the original native highlights/cards so choices can be revised; Apply names the count and destination. |
| Changes already made | Create applied review | `comparison-mode`, `document-review-rail` | Keep / Revert labels and explicit final Revert action. |
| Comparison only | Compare two versions | `comparison-propose`, `comparison-complete` | Rendered versions with native highlights and feedback threads, without approval buttons or destination; Finish comparison cannot write either version. |
| Choose proposal destination | Click Propose these edits | `comparison-convert`, `comparison-convert-target` | Absolute path entry and explanation that conversion does not write the file. |
| Destination conflict | Modify destination externally | `comparison-header-state`, `comparison-conflict`, `comparison-refresh` | Preserved choices, blocked Apply, explicit refresh explanation. |
| Refreshed comparison | Click Refresh comparison | `comparison-refresh-notice` | New current version and undecided changes requiring a fresh decision. |
| Review save failed | Interrupt API during a choice | `comparison-error`, `comparison-retry` | Local choices remain visible; retry is explicit. |
| Completed review | Apply or finish without applying | `comparison-outcome` | Distinguishes a saved destination from “No file was written.” |
| Rendered document | Compare formatted Markdown versions | `page-card-rich-text`, `rich-text-editor` | Real headings, lists, bold text, links, tables and code; native additions/deletions in context. |
| Reviewed choices | Decide a native suggestion, then click Show reviewed changes | `comparison-show-reviewed`, `suggestion-status-<id>` | Selected content by default, original change and saved status when shown again. |
| Linked Markdown changes | Compare several changes in one list/table | `comparison-linked-notice`, `suggestion-status-<id>` | One native group with an explicit linked count; prior mixed choices stay preserved until another action. |
| Native feedback | Reply to a suggestion and edit a reply | `comment-rail-<id>-action-reply`, `comment-rail-<id>-editor` | Full native comment threads, separately saved, including legacy feedback and resolved changes. |
| Detached feedback | Refresh after the original source change disappears | `document-review-rail`, `comment-rail-<id>-action-reply` | Historical feedback remains visible as a document thread; editing and nested replies remain usable. |
| Mobile comparison | Open at 390px wide | `document-review-rail`, `comment-rail-<id>-action-accept` | Native cards and comment actions flow below the document and remain usable. |
| Identical versions | Compare identical source | `comparison-identical` | No-change explanation, disabled write action. |

## Playwright Capture Skeleton
```ts
import { chromium, devices } from "playwright";

const baseUrl = process.env.ROUGHDRAFT_BASE_URL ?? "http://127.0.0.1:5173";
const outDir = process.env.ROUGHDRAFT_SCREENSHOT_DIR ?? ".context/ui-state-screenshots/manual";

const browser = await chromium.launch();
const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await desktop.goto(`${baseUrl}/`);
await desktop.screenshot({ path: `${outDir}/01-home-desktop.png`, fullPage: true });

const mobile = await browser.newPage({ ...devices["iPhone 13"] });
await mobile.goto(`${baseUrl}/`);
await mobile.screenshot({ path: `${outDir}/01-home-mobile.png`, fullPage: true });

await browser.close();
```

For interaction-heavy states, prefer selectors over coordinates. The current code has stable `data-testid` hooks for the homepage storyboard, editor view toggle, mode trigger, conflict banner/actions, review rail, rich editor, code editor, selection menu, link popover, and context menu.
## States That Need A Harness Or Mocking
These are real product states, but they are awkward to capture deterministically through only public routes:

- Initial loading
  
- Save status: saving, failed, and sometimes unsaved
  
- Disk conflict and autosave paused
  
- Review handoff undelivered/error
  
- Remote connected/disconnected banners
  
- Update notice
  

The most reliable long-term solution is a dedicated screenshot harness route or Playwright component harness that renders `DocumentWorkspace` with controlled backend, disk, remote, watcher, and save states. Keep the production-route screenshots for broad layout coverage and use the harness for rare operational states.
## Maintenance Checklist

The shared editor also needs desktop and narrow-screen captures of document
link hover/focus previews (destination, excerpt and Open link), website link
previews, formatted multiline endnote previews, repeated references and their
jump/return controls. Capture these in Editing, Suggesting and Viewing, plus
Before/Diff/After comparison views. Use only disposable fixture documents.

- Add a row when a new route, dialog, popover, banner, editor mode, or empty/error state ships.
  
- Add or update a fixture when a new Markdown/Roughdraft Format feature changes rendering.
  
- Prefer `data-testid` selectors for screenshot automation; add a selector when a state matters visually.
  
- Capture desktop and mobile for page-level states.
  
- Capture both rich-text and code editor for document states that affect the editor surface or review rail.
  
- Keep screenshots in `.context/` unless the run is intentionally being committed as visual documentation.

## Single editor

Capture the rendered editor with no reference, a comparison with an unreviewed change, and a pending suggestion overlapping a reference change. In each state, include the compact header at a scrolled position. Capture the Markdown icon view at that same passage, the Read/Edit/Suggest dropdown, and file details with friendly version labels and full source paths. Capture an agent-selected destination, explicit-none review-only editing, the quiet saved icon and an external file conflict with unsaved text visible. Capture the unified conflict actions and Save separately path/success dialogs described below. Chat reviews have no Send feedback action; capture that action separately for explicit button handoff and legacy waiting reviews.

## Unified live updates and recovery

Use the maintained complete editing fixture, with Keep `s10` and Revert `s11` prepared for History. For file writes use a fresh practice file beside copies of its linked images/documents. The normal live-update view should have no conflict banner for independent edits, saved feedback, equal-content replacements or this page's own save.

| State | Prepare | Capture and verify |
| --- | --- | --- |
| Safe outside update | Change another paragraph on disk or in another tab | Updated passage with the current caret, reading position, local Undo and active comment draft retained. Include an agent edit to a saved commented passage. |
| True overlap | Change the same passage locally and externally | Visible Discard my changes, Overwrite with my changes, Save separately and Compare changes; helper text says only overlapping changes are replaced. Actions stay reachable outside More. |
| Update at the end of a long document | Leave a comment draft open, scroll to the footer, then cause an overlap | The sticky header offers Review update in every view. Its dialog contains the same actions without submitting or losing the private draft. Include a folded phone and a short keyboard viewport; the message identifies disk changes, a newer review, or both from observed state. |
| Compare and confirmation | Open Compare changes, then a destructive action | My version and Latest version, stacked on a phone; overlap count matches the confirmation. Comment, metadata and History conflicts use readable field names and values instead of internal paths or object JSON. Literal prose remains exact. Compare latest for a waiting disk update shows the actual disk text. An unrelated new edit keeps the confirmation usable; a changed overlap refreshes it. |
| Outside update waiting | Make a source mapping/composition unsafe | Specific waiting explanation, preserved local buffer, Reload from file, keep feedback when applicable, and Save separately. No fabricated content conflict. |
| Missing or unwritable file | Rename/remove the practice file or use a read-only practice directory | Actual failure, visible recovery status and available actions; no false Saved indicator. Include an unobservable single-file mount when supported by the harness. |
| Recreate a deleted autosave file | Remove the bound autosave file, then click Recreate file | Confirm the exact missing path and that the working draft is used while review feedback stays intact. Include Original/Final and a folded phone. If the file reappears or the destination changes while confirmation is open, confirmation is disabled; a later race is rejected without replacing the arriving file. Review-only and missing source files have no recreation action. |
| Recovery checkpoint | Leave a conflict open while typing | Checkpoint pending/saved/error status and separate Recovery copies in Review details; open both the initial and latest saved snapshots. Inspect unfinished feedback and explicitly restore it to unchanged comment targets, including a changed-target refusal and checkpoint failure. User-created copies remain distinct. |
| Closed browser work | Close a tab with private feedback or unsaved text, then open the review in another tab | Recovery copies offers inspect, Restore browser work and Dismiss this copy. Restore updates the editor and retains unfinished feedback without submitting it. Dismiss requires confirmation explaining that only the selected browser copy is removed. A resumed owner or changed copy requires fresh inspection. Reloaded tabs do not offer their own claimed predecessor again. |
| Browser recovery storage unavailable | Fill or block browser storage while another tab has unique work | Visible recovery warning, current private text retained, and unrelated browser records intact. Restore storage and retry; the warning clears after the latest recovery is saved. |
| Recovery storage pressure | Preserve enough distinct work to reach the server's recovery target | A visible storage-pressure notice explains that unique work is preserved and offers recovery download or a separate save. |
| Publication did not finish | Leave an interrupted publication for thirty seconds | Review update remains reachable; Recover appears only when the server says it is available. Recovery retains newer typing and feedback without replaying the file write. |
| Mounted file observation limitation | Open a writable single-file mount | A quiet persistent observation warning appears while ordinary guarded saves remain available. The warning alone does not say File changed or pause editing. |
| Another tab overwrites a conflict | Resolve an overlap in favour of the other tab's text | A non-blocking notice links the displaced recovery copy. Include reconnecting after the overwrite; opening recovery must not block current editing or replace its text. |
| Copy name lookup | Open Save separately while the initial response is delayed | Choosing a file name; path and Save copy remain disabled while Cancel is available. On lookup failure, manual path entry becomes available. |
| Copy path dialog | Click Save separately after the initial name lookup | Editable unused path, installation/folder label, working-draft explanation, Cancel and Save copy. Include long/root-relative paths, existing-path error and a changed-folder relative-link acknowledgment. |
| Saved separately | Complete the copy | Popup remains open with the actual returned path, Copy path, Open saved review and Done. Header destination changes only with the intended session switch. |
| Slow/uncertain copy | Delay or lose the save response beyond the lock bound | Save status unknown, original editor usable with writes paused; repeated requests use the same identity. Late success shows path/link without moving newer typing into the older copy. |
| Reload/reconnect | Reload during rejected, never-received and committed-but-unacknowledged saves | Normal saving resumes after a definite outcome; a genuinely indeterminate result exposes Retry save status, Compare latest and Save separately while keeping edits. |
| Detached feedback | Replace the passage carrying a saved comment/suggestion | Original quoted context and displaced proposal remain available with their author, time and replies, without an Overwrite action that restores old agent text. |
| History mapping | Rebase around earlier decisions and repeated text | Reopen remains available only after exact mapping/validation; unsafe entries explain why they are unavailable. Reopen scrolls to the correct passage. |
| Concurrent History | Decide different proposals in two pages before either receives the other decision | Both entries stay distinct and reopen the intended passages. Repeat with both pages deciding the same shared proposal: one History event remains. Reopen a proposal whose identity exists only in History, then decide it again without reusing another entry's identity. |
| Stream reconnect | Keep eight review tabs open through an owned server restart | Saving resumes and temporary polling returns to one shared stream. Include a foreground tab after browser sleep/wake and a supported transport fallback; do not report a permanent polling fallback as restored streaming. |

Repeat applicable recovery states across Read/Edit/Suggest, Changes/Original/Final and formatted/Markdown views. The dialog must say it saves the working draft when an outcome is visible. Capture 390px folded, 840px unfolded, desktop, landscape and short keyboard viewports. Resize with an open path field and reply draft; controls remain reachable, touch targets remain at least 44px and neither draft is lost. Use real Android/Gboard when available and record its absence separately from viewport emulation.

Capture rapid remote updates while typing in the 100 KiB fixture. Verify unchanged blocks do not repeatedly parse, independent pages continue saving, and the receiving page stays responsive. Include concurrent new comment/suggestion IDs, an open reply during renumbering, local Undo/Redo and reload before acknowledgment. Use the shared stream on supported raw HTTP and the visible-only short-request fallback otherwise; eight tabs must still save promptly.


## Mobile and foldable layouts

Use representative 360px folded-cover and 768px unfolded-inner viewports, plus
landscape/short-height screens and a desktop baseline. These are layout test
sizes, not asserted hardware dimensions. Capture both plain-file and unified
comparison routes. Verify readable document text, 44px standalone touch controls,
full-width reading columns and no horizontal page scrolling.

In the unified editor, capture the primary review toolbar and its More actions
popover (copy/download and optional button handoff). Capture the Markdown icon,
Read/Edit/Suggest dropdown, long review title and file-details popover at 360px viewport
height with full paths wrapping and actions reachable. Include comment drafts and replies. Check a pending suggestion
and selected text survive folded-to-unfolded resize without saving unaccepted
wording to the original. Android's keyboard should resize the content viewport;
confirm keyboard behavior on Dan's device as well as browser viewport emulation.

Capture the mobile selection toolbar and URL editor docked above the keyboard
area, selecting words/links at both screen edges. Check the full URL field,
Open/Delete controls, formatting actions, and save/reload. Desktop retains the
contextual toolbar beside its selection. Include a narrow landscape viewport.


## Unified outcome and reviewed-change states

Capture Changes, Original and Final with a mixture of earlier decisions and pending suggestions. Include the read-only preview label, disabled editing/decision controls, rendered and source previews, preserved YAML, and source-relative links/images from inputs in different folders. Verify Copy/Download match the visible outcome. Returning to Changes must restore the interaction mode and working source without adding preview text to Undo.

In Original and Final, verify sibling images actually load through the source file's folder, including when the two inputs contain different images with the same filename. Repeat after switching views and refreshing. Saved and exported Markdown must retain its original relative image paths.

Capture History after refresh, reopening an accepted and rejected passage, a related group of overlapping changes, and the disabled reopening explanation after that passage is edited. Include a long length-changing suggestion with later unrelated edits on both sides. Capture Read after clicking the document and typing: it must remain Read, keep focus in the document and leave the file unchanged.

Reopen decisions from far away in a long document. After History closes, capture the restored passage below the sticky toolbar on desktop, a narrow phone and after unfolding. Include a native suggestion and a YAML-only decision, which returns to its highlighted frontmatter field in the formatted document.

Capture a heavily edited paragraph where short unchanged words between edits appear inside one replacement and one Keep/Revert card. Include clearly separate edits, inline code on either input, hard breaks, lists, tables, pending suggestions and inline comments as grouping boundaries. Capture grouped Keep, refresh, reopening, Revert and Undo, including a saved word-level decision and a comment on a later member. Resize from 390px to 840px while preserving the decision and undo state.

Capture editable full source with comments/suggestions, Read and Suggest source states, YAML/comment Undo and Redo, exact source-spelling edits, and restoration of a rich-text edit made before the source edit. Exercise 360px, 840px, desktop and short landscape viewports with reachable 44px controls and readable source text.


Capture the distinct editable frontmatter block on a narrow phone and unfolded screen. Show a selected YAML field with the normal comment menu, a pending multiline YAML proposal, and its ordinary Keep/Revert card. Capture YAML-only comparisons with one inline field choice, full source outcomes using the corresponding YAML, and body-plus-YAML bulk Undo/Redo retaining unrelated Markdown spelling. Include source Undo after a later reply and after a later comment edit, preserving both feedback and file contents. Capture a CRLF document opened in source without a write, and a long document whose reading passage stays in the same column across source/rendered switching.

Capture two comments on overlapping text, a reply to the outer comment, and replacement of an entire commented selection by typing and by pasting. Each comment must retain its own highlighted range, including spaces, after refresh and Undo/Redo. With the caret in another paragraph, click or tap an inactive comment highlight once: the thread opens and typing belongs at the clicked text. Check desktop clicks and phone taps in comparison and native-file views. Include literal review markers in document prose and comment text containing `<<}`; these must remain readable text through source/formatted switches and refresh, without adding document prose or losing comment content.

Capture native text composition in Edit and Suggest: several unfinished input updates, the final committed text, Undo/Redo, canceling input, and replacing a commented word. Unfinished composition must keep its native cursor and leave the saved document unchanged. In Suggest, the completed input becomes one reviewable proposal; Keep/Revert and refresh preserve the intended text and comment. Include the native file route as well as a saved comparison review.

Capture Suggest edits that split or join paragraphs, add a soft line break with Shift+Enter, continue and indent a list, paste several paragraphs, and change formatting. Changes shows one block proposal with its original and proposed structures; Original and Final show the corresponding clean outcomes. Include a new empty final paragraph, immediate typing, one-step Undo/Redo, Keep/Revert and refresh without unaccepted file writes. Repeat a paragraph split after earlier Keep/Revert decisions and source/formatted switching. Include a comment spanning the changed text and a reply on a grouped existing suggestion; document Undo restores the prior attachment while preserving newer feedback. Verify native-file links retain CriticMarkup autosave and Revert behavior, and use desktop and phone widths.

Capture the toolbar on a coarse-pointer device folded at 390px and unfolded at 840px. Fitting actions stay inline; More contains only the secondary actions that do not fit. Resize with More open and a comment draft active, preserving the draft and accessible touch targets. At 700px, accept the last suggestion and verify the newly available space exposes the secondary actions without another resize. With the complete fixture and History entries, verify that Markdown, Copy and Download remain inline even when History needs More. Include button handoff and long History counts when checking the fit.

Capture pending and saved review status while typing in a small review after a substantial paragraph rewrite without reloading. Keep comments, a pending suggestion and History visible; verify that continued typing stays responsive. Exercise immediate Save, source/outcome switching and folding before the typing queue drains. Include deletion followed by saved Undo/Redo in a CRLF document with noncanonical list markers; exact untouched spelling must survive refresh.
