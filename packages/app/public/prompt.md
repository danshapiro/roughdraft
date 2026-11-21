## Roughdraft

Use Roughdraft when the user wants to review or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

When the user asks for a plan, write the plan as a Markdown file on disk before asking them to review it.

For ordinary editing or review, use the unified editor with a clear title and an explicit autosave choice:

```bash
roughdraft edit "/absolute/path/to/file.md" --title "Review the customer onboarding plan" --autosave "/absolute/path/to/file.md" --json
roughdraft compare "/absolute/path/to/before.md" "/absolute/path/to/after.md" --title "Review the customer onboarding changes" --before-label Original --after-label Revised --autosave none --json
```

Choose a title that makes sense to someone new to the project. Keep the actual review request in your chat message; do not duplicate it in the app. Use friendly version labels and always choose the autosave destination yourself. `none` keeps edits, comments, decisions, and suggestions in the review without writing a Markdown file. A new output path starts from the revised version unless you pass `--autosave-base old`.

Without an explicit server, the command starts or reuses this checkout's Roughdraft and returns immediately with a checked review URL. Give the user that complete URL unchanged and tell them to return to chat when ready. Keep the full URL, including its server and review ID. Do not start a waiting process or ask the user to select a file or press Send feedback.

If a preview or integration already supplied a server, pass `--server "EXACT_SERVER_URL"` to create the review there. An exact target fails if unavailable; it never starts a different server or changes ports. `--port` is a startup preference, not an exact destination. Never replace the server address in a returned review URL or join a new address with an old ID. A public-address override must pass the CLI's saved-review and server checks before handoff.

For changes to the Roughdraft repository itself, use `pnpm --silent preview --json` to build, preserve, open, and verify the real README review in one operation. Use `--document` or `--title` when appropriate. Return its `url` unchanged and keep its `readCommand` argument array for retrieving feedback through the preserved runtime. Do not assemble a custom runtime or move review records between servers. Existing kept reviews remain available until the user accepts them.

When the user returns, retrieve the latest saved review:

```bash
roughdraft comparison "FULL_REVIEW_URL" --read --json
```

The full URL returns to the original server even when your working directory changes. Read the `comparison` object’s `draft` and `reviewComments`, along with decisions and save status. Also read `recoveredReviews`: these contain complete feedback preserved from conflicting browsers, including later recoveries. Read any selected destination from disk before making separately authorized changes. Pending suggestions are feedback; retrieval is not permission to apply them. If saving failed or another browser changed the review, preserve the user's work and address the visible error before assuming all feedback reached the server. The user can use Preserve this review to save conflicting feedback separately without selecting a file.

Use `--watch` only when an integration explicitly needs a Send feedback button and a blocking completion result. Existing inline CriticMarkup workflows remain available through `roughdraft open FILE.md`; that command keeps its original Done Reviewing wait. For that workflow, read the Markdown from disk after review and reply inline using the format below.

Use Roughdraft-flavored CriticMarkup when reading or writing inline review feedback in Markdown. The base markers are:

Comment: `{>>comment<<}`
Insertion: `{++new text++}`
Deletion: `{--old text--}`
Substitution: `{~~old~>new~~}`
Highlight: `{==text==}`

When you add a new comment or suggested change, use the extended Roughdraft format with a compact inline reference such as `{#c1}` or `{#s1}`, then add metadata in final YAML endmatter. Generate a stable document-local id (`c1`, `c2`, etc. for comments; `s1`, `s2`, etc. for suggestions), set `by` to your agent or author label, set `at` to the current ISO timestamp, and set `re` when replying to an existing comment or suggestion.

Roughdraft may already have inline attribute blocks after comments and suggestions from older documents. Preserve those attributes unless you are intentionally removing the associated comment or suggestion. For new feedback, prefer compact references plus YAML endmatter.

Anchored comments usually look like `{==selected text==}{>>Comment text<<}{#c1}`. Suggested changes usually look like `{++new text++}{#s1}` or `{~~old text~>new text~~}{#s2}`. Replies live in final YAML endmatter with a `body` and `re` pointer.

Example:

```markdown
{==selected text==}{>>Comment text<<}{#c1}
{++new text++}{#s1}

---
comments:
  c1:
    by: AI
    at: "2026-04-28T12:00:00.000Z"
  c2:
    body: I can make that edit.
    by: AI
    at: "2026-04-28T12:05:00.000Z"
    re: c1
suggestions:
  s1:
    by: AI
    at: "2026-04-28T12:10:00.000Z"
```

Use `roughdraft help` and `roughdraft help criticmarkup` for local command and syntax details.
