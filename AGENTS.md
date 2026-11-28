# Roughdraft Agent Instructions

## Shared application source

This repository's `main` is the application source for both garageserver's local
editor and Glowfer. Shared editor, comparison, link and endnote behavior belongs
here. The machines repository owns local mounts, wrapper and packaging; the
Glowfer repository owns its authorization, bot isolation, wrapper and packaging.
Both deployments pin a tested commit from this repository. App changes need
new deployment artifacts and each installation's documented rollout; merging
app source alone does not update either running service.

When the user requests an install or deployment, update every installation that
uses Roughdraft, including garageserver and Glowfer, unless they specify a narrower scope.

## Testing Principles

Use the repo-local `test-desiderata` skill when planning, adding, changing, or reviewing tests. Keep the core bar visible even when the skill is not loaded: tests should optimize for Kent Beck's Test Desiderata (https://testdesiderata.com/) as context-specific tradeoffs, not as a mechanical checklist.

Before finalizing test work, check that the tests are:

- Isolated: results do not depend on execution order or shared mutable state.
- Composable: tests combine without hidden coupling.
- Deterministic: unchanged code and inputs produce the same result every run.
- Fast: tests are quick enough to run during normal development.
- Writable: tests are cheap to create relative to the behavior protected.
- Readable: tests make their motivation and expected behavior clear.
- Behavioral: tests fail when the behavior under test changes.
- Structure-insensitive: tests survive internal refactors that preserve behavior.
- Automated: tests run without manual intervention.
- Specific: failures point clearly at the broken behavior.
- Predictive: passing tests justify confidence in production behavior.
- Inspiring: the suite increases confidence instead of creating noise or avoidance.

Prefer the fastest test that remains predictive. Escalate to integration or e2e coverage when the boundary itself is the behavior under test, and make any meaningful tradeoff explicit in the final summary.

`docs/solutions/` contains documented solutions to past problems, organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). It is relevant context when implementing, debugging, or choosing tests in documented areas.

## Bug Fix Workflow

When the user asks you to fix something, first have a subagent reproduce the bug with a failing test case before implementing the fix. The subagent should focus on the smallest behavioral test that demonstrates the problem, and should report the failing command, changed test files, and why the failure captures the requested bug.

### Prove It Pattern

For every bug fix:

1. Reproduce the failure before changing production code. Prefer the smallest automated test that exercises the actual buggy path and fails for the reported behavior.
2. If the bug crosses a boundary such as the OS, browser, CLI subprocess, filesystem watcher, network, or a third-party tool, also run a realistic command or flow that exercises that boundary. A mocked unit test can cover branching logic, but it does not prove the external command syntax, output shape, permissions, launch behavior, or integration contract.
3. Implement the fix.
4. Rerun the failing test or realistic reproduction and confirm it now passes.
5. Run the narrow relevant test command first, then the broader check when the change is broad enough to justify it.

If a realistic reproduction is infeasible, document why before proceeding and include the remaining verification gap in the final summary.

### Realistic Verification Before Handoff

Before asking the user to test or review a change, verify the riskiest changed behavior with the most realistic feasible check:

- For CLI behavior, run the actual worktree CLI or the exact subprocess command it will invoke.
- For browser behavior, open the affected route in a real browser automation flow when possible.
- For OS integration, run the target OS command directly and inspect its real output.
- For file-backed behavior, exercise the real file path, watcher, or save/load cycle.
- For external APIs or libraries, verify against official docs or a real local integration point rather than only mocked assumptions.

Mocked tests are still useful, but they are not a substitute when the boundary itself is the product behavior.

In the final response, list the verification commands run, what each proved, and any residual realism gap.

## Slog Default

This repo vendors the `slog` skill at `.codex/skills/slog`.

Treat `slog` as a default self-verification tool in this repo.

- Use `slog` when fixing bugs.
- Use `slog` when building new features.
- Use `slog` during planning when you need to verify your understanding of the current code path before changing it.
- Default pattern: mint a fresh run, add focused logs around the decision points, exercise the path, read the log file, and summarize what the logs prove.
- Prefer `slog` over guesswork when the task depends on how the code actually behaves at runtime.

Basic workflow:

```bash
bun .codex/skills/slog/scripts/slog.ts new <label>
```

- Restart any long-running local services after creating the run so they pick up `.context/slog/current.env`.
- For one-shot commands, source or export `.context/slog/current.env` before running the command.
- Inspect the latest file with:

```bash
bun .codex/skills/slog/scripts/slog.ts latest file
```

## UI Components

Always use shadcn for UI work in this repo. Prefer existing components in `packages/app/src/components/ui/`; when a needed primitive is missing, add it there in the same shadcn style before wiring it into product code.

## Mobile and foldable UX

Unless the user requests otherwise, design and review UX for mobile as well as
desktop. Keep document text comfortably readable without zooming (normally at
least 16 CSS px), use readable control labels, and give standalone touch controls
at least 44 by 44 CSS px of usable space. Keep important actions reachable and
avoid horizontal page scrolling or dialogs that hide their actions.

Dan uses a Galaxy Fold 8 Ultra. Consider both its narrow folded cover screen and
its larger unfolded inner screen, in portrait and landscape. Check representative
phone and foldable viewport sizes rather than assuming one fixed resolution, and
preserve edits and review state when the viewport changes as the device unfolds
or the on-screen keyboard appears.

## UI Screenshot Guide

When changing UI behavior, routes, dialogs, popovers, banners, editor modes, review rail states, or visual error/empty states, update `docs/spec/ui-state-screenshot-guide.md` if the change adds, removes, or materially changes a state that should be captured for visual review.

Keep generated screenshot runs in `.context/ui-state-screenshots/` unless the user explicitly asks to commit visual artifacts.

After every change, give Dan a working Roughdraft link to a real, complex Markdown document running on the updated app. Use `pnpm --silent preview --json` to build and preserve that review, with the real README and autosave `none` by default; pass `--document` or `--title` when useful. Return its complete verified `url` unchanged and retain its `readCommand` argument array for later feedback retrieval. Keep the review until accepted.

For editing or review changes, use the maintained [editing review fixture](docs/spec/fixtures/editing-review.md) with `--document docs/spec/fixtures/editing-review.md --before docs/spec/fixtures/editing-review-original.md`; the README alone does not cover those behaviors. Keep `s10` and Revert `s11` to prepare the History examples, leaving the other changes pending. For file-write testing, choose a fresh practice autosave file and preserve its relative images and linked documents beside it; otherwise use `none`.

For an existing server, use `--server URL`; `--port` is only a startup preference. Never reconstruct a review link from a different address and a saved ID. Read feedback using `comparison "FULL_REVIEW_URL" --read --json`, so it returns to the original server. A healthy application alone does not verify that the linked review exists.

## Worktree-Specific CLI

This repo installs a worktree-specific Roughdraft CLI wrapper during setup.

- `roughdraft` is the published npm package
- `roughdraft-dev-<worktree-name>` is the local CLI for one specific checkout

In a fresh worktree, `pnpm setup` runs `pnpm dev:install-cli`, which creates a wrapper in `~/.local/bin` by default.

To derive the correct command for the current checkout, use the git worktree root, then take its basename:

```bash
worktree_root="$(git rev-parse --show-toplevel)"
worktree_name="$(basename "$worktree_root")"
roughdraft_cmd="roughdraft-dev-$worktree_name"
```

Example in this checkout:

```bash
roughdraft-dev-shanghai-v4 start
```

Do not use the global `roughdraft` command for repo-local development in this repo unless the user explicitly asks for the published package.

## Fallback If The Wrapper Is Missing

Setup should install the wrapper automatically, but if the command is missing:

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm dev:install-cli
```

Then recompute `roughdraft_cmd` and use it.

## Pull Request Workflow

Before creating or updating a PR:

1. Run `pnpm check`.
2. Run `pnpm test:smoke`, especially after UI, routing, editor, file-backend, or workflow changes. This mirrors the browser smoke step in CI and is not covered by `pnpm check`.
3. Fix any lint, format, test, smoke, or build failures.
4. Confirm `git status --short` only shows intended changes.
5. Make sure the current branch name is descriptive. If it is random or unclear, rename it before pushing.
6. Rebase the current branch on the latest `origin/main`.
7. Commit and push.
8. Create the PR with `gh pr create --base main`.
9. If the PR resolves GitHub issues, include closing keywords such as `Fixes #123` in the PR body.

## Plan Writing Workflow

When the user asks for a plan, write the plan as a Markdown file in `.context/` so it is easy to review, revise, and keep out of commits.

Before writing the plan:

1. Read every ADR in `docs/adr/` if that directory exists.
2. Read the code, tests, and docs needed to ground the plan in the current implementation.
3. Use `slog` if runtime behavior needs verification before the plan can be accurate.

Plan file guidelines:

- Use a concrete, task-specific filename such as `.context/markdown-smoke-tests-plan.md`.
- Include goals, non-goals, proposed file changes, test strategy, risks, and suggested implementation order.
- Keep product-boundary decisions aligned with the ADRs; if the plan needs to change a recorded decision, call that out explicitly.
- Use CriticMarkup for inline review notes when helpful.

After writing the plan, open it in the unified editor with a clear title and an explicit autosave choice:

```bash
worktree_root="$(git rev-parse --show-toplevel)"
worktree_name="$(basename "$worktree_root")"
roughdraft_cmd="roughdraft-dev-$worktree_name"
"$roughdraft_cmd" edit "$worktree_root/.context/<plan-file>.md" --title "Review the <task> plan" --autosave "$worktree_root/.context/<plan-file>.md" --json
```

If an existing review server should own the review, add `--server URL`. Return the complete verified URL unchanged. When the user returns to chat, read that full URL with `comparison "FULL_REVIEW_URL" --read --json`, then read the plan file from disk. Address the saved comments and suggestions before implementing; sidecar feedback may not appear in the Markdown file.

## Implementation Notes Workflow

When implementing a plan or spec, keep a running implementation notes file in `.context/` by default, such as `.context/implementation-notes.md` or a task-specific filename like `.context/markdown-smoke-tests-implementation-notes.md`.

Use the notes file to record how reality diverged from the plan or what the plan did not cover:

- Decisions you had to make that were not specified.
- Product, design, architecture, or testing tradeoffs you made.
- Parts of the plan or spec that had to change once you read or ran the code.
- Important constraints, follow-up work, or risks the user should know about.

Update the notes as you implement, not only at the end. In the final response, mention the implementation notes file and summarize the most important deviations or decisions.

## Roughdraft Workflow

Use Roughdraft when the user wants to open, review, or comment on a Markdown file.

The user may refer to Roughdraft as `rd` in natural language. Treat `rd` as shorthand for Roughdraft in user requests, but do not create or modify any shell alias, executable, symlink, or command named `rd`.

Preferred flow:

1. Derive `roughdraft_cmd` for the current worktree and run its help when needed.
2. For ordinary Markdown editing or review, use `edit` with a readable title and an explicit autosave path or `none`. It starts the appropriate local server if needed. Use `--server URL` to bind an existing destination exactly.
3. Keep and return the complete verified review URL unchanged. The normal command returns immediately; the user tells the agent in chat when ready.
4. Read current drafts, comments, suggestions and decisions with `comparison "FULL_REVIEW_URL" --read --json`, then read any autosave file before making separately authorized edits.
5. For changes to Roughdraft itself, use `pnpm --silent preview --json` for the preserved real-document review and execute its emitted `readCommand` to read feedback, rather than assembling servers, links or connection settings manually.

The original inline CriticMarkup workflow remains available through `open FILE.md` when specifically needed. That command retains its Done Reviewing wait and file-based feedback. `start`, `status` and `stop` remain available for process management; connecting with `--server` does not authorize stopping a server owned by another task.

## CriticMarkup

The [RFM format specification](docs/spec/roughdraft-flavored-markdown.md) describes escaping and declared frontmatter/code annotations.

Use CriticMarkup when reading or writing inline review feedback in markdown:

- Comment: `{>>comment<<}`
- Insertion: `{++new text++}`
- Deletion: `{--old text--}`
- Substitution: `{~~old~>new~~}`
- Highlight: `{==text==}`

When adding new review feedback, prefer compact inline references plus final YAML endmatter:

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

Older inline attribute blocks such as `{id="c1" by="AI" at="2026-04-28T12:00:00.000Z"}` may appear in existing documents. Preserve them unless you are intentionally rewriting that review item.
