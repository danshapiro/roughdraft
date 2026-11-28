# Roughdraft
A local-first markdown editor and viewer for working with AI.

{==Open one markdown file on your machine. Review it, comment on it, and suggest edits.==}{>>What does this mean?<<}{id="c3" by="user" at="2026-04-30T20:18:51.163Z"}{>>It means Roughdraft works with a normal local Markdown file: you open one .md file from your computer, read it in the app, leave inline comments, and propose edits that are saved back into the Markdown using CriticMarkup.<<}{id="c4" by="AI" at="2026-04-30T20:19:39.000Z" re="c3"}{>>cjool<<}{id="c5" by="user" at="2026-05-07T20:38:25.621Z" re="c4"}

Paste this into your coding agent:

```text
Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.md/setup.md and set yourself up to use it.
```

Or install and open a file yourself:

```bash
npm i -g roughdraft
roughdraft edit /absolute/path/to/file.md
```
## What is this?
Roughdraft is a local-first markdown editor and viewer that runs on your computer.

Its job is to make markdown files easy to open, read, edit, review, and discuss with your AI agent without moving them into a proprietary format or a hosted app.

Roughdraft edits one Markdown document at a time, with optional comments, suggestions, and a comparison reference.
## How it works
- **Local-first markdown editor** — Open normal `.md` files from your machine and edit them directly
  
- **Works with your AI agent** — Tell your local agent to open a file in Roughdraft on your computer, then keep collaborating from there
  
- **Comments & suggested changes** — Review inline without adding annotations to the Markdown file
  
- **Markdown files on disk** — Everything stays as regular markdown files you can also edit in VS Code, Vim, Cursor, or anywhere else
  
- **No cloud, no account, no telemetry** — Runs entirely on your machine
  
## Open the editor

```bash
roughdraft edit ./draft.md
roughdraft edit --autosave none  # start a draft without writing a file
```

Roughdraft starts its local server if needed, checks that the complete review link reaches the saved review, prints it, and returns immediately. Use `--no-open` on a headless machine. Tell your agent in chat when you are ready for it to read your feedback.

- **Read** prevents accidental document edits. **Edit** puts your typing in the document. **Suggest** records proposed wording, formatting, paragraph and list edits for review. The selected mode survives refresh. **Keep** adds a suggestion to the document; **Revert** discards it.
- YAML frontmatter appears in a distinct text block at the top of the formatted document. Click its fields to edit, suggest or comment using the same controls as the rest of the document. Undo, History, autosave and outcome previews include those fields. YAML punctuation stays literal, and temporary incomplete values are allowed while you type. Use Markdown source to change its opening or closing fence.
- The **Changes** dropdown also offers **Original** and **Final**. These are read-only previews of the complete outcomes, including YAML fields, earlier decisions and pending suggestions. Switching views never changes your decisions or writes the preview to a file. Copy and Download export the visible preview while you are in a preview.
- Your agent chooses the autosave file before opening a review, or chooses `none` to keep edits in the review without writing a Markdown file. **Review details** shows the full source paths and save destination. A quiet check indicates saved work; saving failures remain visible. The document follows changes made on disk or in another saved review. Independent edits are combined automatically; overlapping edits show the recovery actions below.
- In **Changes**, **Copy Markdown** and **Download Markdown** use the same clean Markdown as autosave. Pending suggestions and comments stay in the review. The **Markdown** icon opens the full document source, including inline review markup. Source is editable in Edit; Read, Suggest and outcome previews keep it read-only. Toggle the icon again to return to the formatted document.
- **Undo** and **Redo** cover document edits and Keep/Revert choices while the editor stays open, including after a save. **History** (inside **More** on smaller screens) lets you inspect and reopen decisions after refreshing. Reopening scrolls to the restored passage. Related overlapping changes are reviewed together. Reopening preserves unrelated later edits; a passage rewritten after its decision cannot be reopened over that newer text. Earlier suggestions may be unavailable in outcome previews after a passage is rewritten. Comment history is separate. Document edits save as you type. Unfinished comment drafts are preserved; Save or Ctrl/Cmd+Enter publishes the comment. Cancel keeps the previously saved comment.

## When the document changes elsewhere

An agent's file edits and another tab's saved feedback appear in the open review without refreshing. Your selection, reading position and unfinished typing stay in place. Saved comments remain available when their quoted passage changes; a suggestion that no longer fits stays as feedback for the agent. A direct `edit FILE --autosave none` can follow the source without writing to it. Comparisons keep their original version references.

For `edit FILE --autosave none`, `comparison "FULL_REVIEW_URL" --read --json` reports `targetChanged` and `liveSourceChanged` when the source has changed since the saved review. The returned draft is the saved feedback; read the current source file too before making further edits. A file mounted individually may not reveal changes made by its host. Roughdraft shows that limitation while allowing saves with the usual file checks.

If both sides changed the same passage or review item, saving pauses while you keep editing. **Compare changes** shows your version and the latest version before you choose:

1. **Discard my changes** uses the latest version of the overlapping parts. Unrelated edits and feedback from both sides stay.
2. **Overwrite with my changes** uses your version of the overlapping parts after confirmation. Unrelated incoming work stays.
3. **Save separately** opens a path dialog for a new Markdown file and its complete Roughdraft review. The suggested file is in the current folder when possible. After saving, the popup shows the actual saved path and a link to the new review. The Markdown file contains clean working text; comments, pending suggestions and History remain in the new review.

These actions use the working draft even while **Original** or **Final** is displayed. Save separately is also available when the file is unavailable, an outside update cannot be applied safely, or a previous save's result cannot be recovered. Changing the copy's folder can affect relative links; the dialog explains the affected links before saving. Paths refer to the server running Roughdraft, with a named Documents folder on installations that restrict file access.

Save separately also preserves unfinished comment and reply drafts. Open **Recovery copies** in Review details to inspect them or restore them to their editors. Changed comment passages stay in the recovery copy for inspection.

**Review update** stays in the header when an update needs attention, including near the end of a long document. It opens the waiting update and its recovery actions in any document view.

If your autosave file was deleted, **Recreate file** asks you to confirm its exact path before creating it from the working draft. Your review feedback stays intact. If a file appears there first, Roughdraft stops without replacing it. Reviews with autosave `none` do not offer this action.

Recovery copies also offers work left by quiet browser tabs. Inspect it, then choose **Restore browser work** to bring its document and unfinished feedback into the editor. Your current unsaved work is preserved first. **Dismiss this copy** asks for confirmation and removes only that browser recovery copy; it does not change the open review or saved file. If a publication did not finish, **Recover** restores the saved review without repeating the file write.

While a connection is unavailable, your work stays in the open tab as Roughdraft reconnects. An uncertain save is checked before retrying so it cannot create duplicate suggestions or files. A mounted file that cannot expose outside changes shows that limitation explicitly.

## Review file changes

A comparison shows inline highlights and **Keep**/**Revert** cards in the same editor. **Keep** chooses the revised wording for that passage; **Revert** chooses the original wording. The agent selects the save destination, so reading, commenting, suggesting, editing, and decisions need no file-selection step. With `--autosave none`, all of that stays in the saved review and neither input file changes.

Nearby wording changes within a paragraph share one **Keep**/**Revert** card when only a short unchanged phrase separates them. Clearly separated edits, code and separate paragraphs remain separate. Existing decisions and comment anchors stay attached to their passages.

| What you want to review | Command |
| --- | --- |
| A proposed update | `roughdraft propose AGENTS.md --after AGENTS.proposed.md --title "Review the agent working instructions" --autosave AGENTS.md` |
| Changes already made | `roughdraft review AGENTS.md --before AGENTS.before.md --title "Review the updated agent instructions" --autosave AGENTS.md` |
| Any two versions, without writing either | `roughdraft compare BEFORE.md AFTER.md --title "Compare the product page revisions" --before-label Original --after-label Revised --autosave none` |

Use `roughdraft snapshot AGENTS.md --out AGENTS.before.md` before making changes you plan to review. A snapshot preserves the exact bytes and won't overwrite an existing snapshot. A new autosave output starts from the revised version; use `--autosave-base old` to start from the original. Existing unrelated output files are never replaced implicitly.

Agents should always provide a title understandable to someone new to the project and an explicit `--autosave PATH` or `--autosave none`. Keep the review request in chat. Friendly version labels appear in the header; full paths are available on hover and through keyboard-accessible **Review details**.

An agent can also provide `--copy-directory PATH` to suggest a folder for Save separately. The path is a folder on the selected server, either an absolute local path or a logical path inside a restricted installation's Documents folder. The server validates it; the user does not need to configure a recovery folder.

Keep the complete returned URL unchanged. When the user returns to chat, read the current saved review with `roughdraft comparison "FULL_REVIEW_URL" --read --json`. The URL selects both the review and the server that owns it, even from another checkout. Bare IDs remain available for local workflows. This returns `comparison.read` with the complete review, including its latest `draft`, `reviewComments`, decisions, save destination, and current file state. Preserved copies are included in `recoveredReviews`. It opens no browser, waits for no button, and freezes no snapshot. Reread the destination before any separately authorized changes; reading feedback does not imply approval to apply suggestions.

Integrations that need a button can explicitly pass `--watch`. Those reviews show **Send feedback**, which freezes a snapshot and returns `comparison.completed` with `comparison.feedback`. Sending does not itself write a Markdown file. Use `--timeout SECONDS` to change the 30-minute wait; a timeout is not approval. `roughdraft comparison "FULL_REVIEW_URL" --watch` reopens the original review for this button flow. Older saved waiting sessions retain their button.

Older comparison links still open their original review. `roughdraft open` and `roughdraft mcp` continue to support the original inline CriticMarkup workflow for tools that use it.

## Open a review on an existing server

Use `--server` when a preview or integration has already started the server:

```bash
roughdraft edit ./draft.md --server https://your-preview-server/ --title "Review the customer welcome guide" --autosave none --json
roughdraft comparison "https://your-preview-server/?comparison=REVIEW_ID" --read --json
```

`--server` uses that exact existing server or reports an error. It never starts another server or chooses a different port. The server must support file reviews and have access to the supplied paths. Connecting does not give the CLI ownership of that server.

`--port` remains a preferred port for automatic local startup. It can choose another port when the requested one belongs to another checkout; use `--server` to select an existing destination exactly.

Roughdraft checks the saved review and the application route through the final browser address before reporting a successful link. `ROUGHDRAFT_PUBLIC_URL` can name a public alias, but that address must reach the same review server. If creation succeeds and the public check fails, the error retains the created review ID and actual server so it can be recovered without creating another review.

## Local development

For a server reached from another machine, set `ROUGHDRAFT_BIND_HOST` and
`ROUGHDRAFT_TOKEN`, then open files from their source machine with
`ROUGHDRAFT_HOST=https://your-roughdraft-server roughdraft open ./draft.md` using the same
token. Keep that CLI running while you edit. Network-bound servers support
remote document sessions; they do not browse, edit, or compare files on the
server itself. Use a loopback-only server for those local-file workflows.

```bash
./scripts/setup.sh
./scripts/run.sh
```

`./scripts/setup.sh` installs workspace dependencies and builds the app and server. `./scripts/run.sh` serves the built app at `http://localhost:7373`.

The two scripts coordinate through a lock file, so it's safe to start `./scripts/run.sh` while `./scripts/setup.sh` is still in progress. `run` will wait for setup to finish, or trigger setup itself if nothing has been built yet.

If you prefer package scripts, the same commands are available as `pnpm setup` and `pnpm start`.

Running `pnpm setup` also installs a per-worktree dev CLI wrapper into `~/.local/bin` by default, using the current worktree directory name. For example, this checkout might install `roughdraft-dev-lyon-v2`, which points at this worktree's local code while leaving the published global `roughdraft` command untouched.

Each dev wrapper keeps its own server state under `~/.roughdraft/dev/<wrapper-name>` by default, so opening a file from one worktree will not accidentally reuse a backend started from another worktree. `roughdraft-dev-<worktree> open ...` can start its own background server as needed; you do not need to run `pnpm dev` first just to open files in Roughdraft.

You can refresh that wrapper manually with:

```bash
pnpm dev:install-cli
pnpm dev:install-cli --name api-redesign
```

To review changes to Roughdraft itself, run:

```bash
pnpm preview
```

This builds the updated app, keeps an independent preview available, and opens the real README in the unified editor. Edits and feedback stay in the saved review by default. It returns the complete checked URL, which can be opened on the desktop or phone. Run it again to reopen the same review when its build and inputs have not changed; a changed build gets a separate preview so existing feedback remains available.

Choose another document or a more specific title when useful:

```bash
pnpm preview --document ./README.md --title "Review Roughdraft editing and review links"
pnpm --silent preview --json
```

The preview command uses the installed `devservers` helper and preserves its runtime, linked Markdown and referenced local assets outside the task worktree. Unsupported absolute local links or images above a document’s folder are reported before a preview starts. Return its URL unchanged. For agents, `pnpm --silent preview --json` also supplies a `readCommand` argument array; retain and execute it to retrieve feedback through the preserved runtime and its connection settings. The full URL remains the review handle. Production installation rollouts remain separate.

Quality checks:

```bash
pnpm lint
pnpm test
pnpm check
```

`pnpm check` is the same command the pull request workflow runs before merge.
## Publishing
Roughdraft publishes from `main` when the root `package.json` version is newer than the current npm `latest` version.

Release flow:

1. Bump the root `package.json` version in a pull request.
  
2. Merge the pull request to `main`.
  
3. The `Publish to npm` GitHub Actions workflow runs `pnpm check`, publishes the package if that exact version is not already on npm and is newer than `latest`, then creates a `v<version>` git tag.
  

The workflow uses npm trusted publishing, so npm must be configured with this trusted publisher:

```text
Owner: Lex-Inc
Repository: roughdraft
Workflow filename: publish.yml
```

No `NPM_TOKEN` secret is required.
## Files on disk
```
my-essay/
  draft-1.md            # A normal markdown file on disk
  draft-2.md            # Another file you can open separately
```

Roughdraft reads and writes the selected Markdown file directly. It keeps comments, suggestions, and review progress in its server state under `comparisons/` (by default `~/.roughdraft/comparisons/`), so they reopen with the review without adding files to your project.
## Agent setup
If you want your local agent to remember the Roughdraft workflow, ask it to read the live setup prompt:

```text
Install Roughdraft for me using `npm i -g roughdraft`, then read https://roughdraft.md/setup.md and set yourself up to use it.
```

Use `roughdraft help`, `roughdraft help agent`, or `roughdraft help criticmarkup` if you need a local refresher.
## CLI reference
```text
roughdraft [flags] <command> [args]
roughdraft <path>
```

Commands:

```text
edit [path]        Open the editor; return the review URL and ID
review <path>      Review edits against --before SNAPSHOT
propose <path>     Review proposed text from --after PROPOSED
compare <a> <b>    Compare two versions
comparison <url|id> Reopen a review; --read --json retrieves feedback
open <path>        Open an inline CriticMarkup session; wait for Done Reviewing
start              Start or reuse the background server
status             Show server status
stop               Stop the managed background server
watch <path>       Wait for a Done Reviewing event
mcp                Start the experimental stdio MCP server
doctor [path]      Diagnose setup or validate Markdown
help agent         Print the agent setup prompt
help criticmarkup  Show CriticMarkup examples
agent-setup        Print the agent setup prompt
criticmarkup       Show CriticMarkup examples
```

Global flags:

```text
-h, --help         Show help
--version          Print version
--json             Print JSON for supported commands
--no-color         Disable color
```

Useful command flags:

```text
roughdraft open <path> --no-open
roughdraft open <path> --print-url
roughdraft open <path> --json
roughdraft open <path> --no-watch
roughdraft start --port <port>
roughdraft status --json
roughdraft stop --all
roughdraft watch ./draft.md --json
roughdraft doctor --json
roughdraft doctor ./draft.md
roughdraft doctor ./draft.md --json
```

Usage errors return exit code `2`. Runtime failures return exit code `1`. `roughdraft status --json` returns exit code `0` even when the JSON says `"running": false`.

Supported environment variables:

```text
ROUGHDRAFT_PORT
  Preferred server port.

PORT
  Legacy preferred server port. Used only when ROUGHDRAFT_PORT is unset.

ROUGHDRAFT_NO_OPEN=1
  Disable browser/app opening.

ROUGHDRAFT_STATE_FILE
  Exact path to the server state JSON file.

ROUGHDRAFT_STATE_DIR
  Directory containing server.json.
```

Development-only environment variables:

```text
ROUGHDRAFT_DEV_FRONTEND_STATE_FILE
ROUGHDRAFT_DEV_BIN_DIR
ROUGHDRAFT_DEV_STATE_BASE_DIR
ROUGHDRAFT_DEV_WRAPPER_NAME
ROUGHDRAFT_DEV_WRAPPER_PATH
ROUGHDRAFT_DEV_WRAPPER_REPO_ROOT
```
## Roughdraft-flavored CriticMarkup
Roughdraft uses [CriticMarkup](https://criticmarkup.com) as the readable review layer inside normal Markdown files. It supports the standard markers for comments, highlights, insertions, deletions, and substitutions:

The canonical Roughdraft Flavored Markdown spec is published at [roughdraft.md/spec/roughdraft-flavored-markdown.md](https://roughdraft.md/spec/roughdraft-flavored-markdown.md). The review-index JSON Schema is published at [roughdraft.md/spec/roughdraft-flavored-markdown.schema.json](https://roughdraft.md/spec/roughdraft-flavored-markdown.schema.json).

```markdown
This is {--deleted--} text.
This is {++inserted++} text.
This is {~~old~>new~~} substituted text.
This is {>>a comment<<} in the margin.
This is {==highlighted==} text.
```

Roughdraft extends those markers with compact id references so review state can round-trip through the file. Root comments and suggestions keep an inline anchor such as `{#c1}` or `{#s1}`, while metadata lives in final YAML endmatter:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-06-14T06:38:34.897Z"}{>><<}{id="c6" by="user" at="2026-06-14T06:48:16.819Z" re="c1"}. --- comments: c1: by: user at: "2026-04-28T12:00:00.000Z"
```

Supported attributes:

- `id` is the compact inline reference after the comment or suggested change.
  
- `by` records the reviewer or agent that created it.
  
- `at` records an ISO timestamp.
  
- `re` links a reply to another comment or suggestion id.
  

Replies are stored in endmatter with a `body` and `re` pointer:

```markdown
Please revisit {==this sentence==}{>>Needs a source<<}{id="c1" by="user" at="2026-06-14T06:38:34.897Z"}{>><<}{id="c6" by="user" at="2026-06-14T06:48:16.819Z" re="c1"}. --- comments: c1: by: user at: "2026-04-28T12:00:00.000Z" c2: body: I can add one from the intro. by: AI at: "2026-04-28T12:05:00.000Z" re: c1
```

Suggested changes can also carry ids and discussion:

```markdown
Add {++one concrete example++}{#s1}.
Remove {--vague phrasing--}{#s2}.
Use {~~rough~>specific~~}{#s3} wording.

---
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
  s2:
    by: user
    at: "2026-04-28T12:13:00.000Z"
  s3:
    by: AI
    at: "2026-04-28T12:14:00.000Z"
```

Older inline metadata such as `{id="c1" by="user" at="..."}` and legacy `{@id:c1; by:user; at:...@}` blocks are still accepted for compatibility.

CriticMarkup inside inline code and fenced code blocks is treated as literal example text, not live review feedback:

````markdown
Inline code stays literal: `{==not a comment==}`.

```text
{++not a suggestion++}
```
````

This matters because the main workflow is often:

- The AI writes a doc
  
- The user opens it in Roughdraft
  
- The user leaves comments and suggested changes
  
- The AI reads those comments and responds in the same markdown file
  
## Try the demo
Don't want to install anything? Try the [live demo](https://roughdraft.md) — it runs entirely in your browser using local storage.
## License
MIT

* * *

Built by [Nathan Baschez](https://twitter.com/nbashaw)
