# 0005: Persisted File Comparison Reviews

## Context

Reviewing two versions of a Markdown file needs a stable before version, an after version, and decisions that do not rewrite the active file while the user is reviewing. A proposed edit, an edit already made, and a comparison with no destination have different write semantics. The review also needs to survive server restarts.

## Decision

File comparisons use separate, persisted JSON review records. Each record holds frozen source snapshots, exact-source change blocks, choices, comments, an optional explicit destination, and a durable completion result. These records live in `ROUGHDRAFT_COMPARISONS_DIR`, defaulting to `~/.roughdraft/comparisons`, separately from the CLI process state file.

Ordinary Markdown editing and CriticMarkup reviews keep their existing representation. This is a focused extension to ADR 0002 and ADR 0004: comparison choices and comments belong to the comparison record because saving them into the destination would itself change the file under review. The process state file retains only its existing process-management role.

Proposals write accepted blocks only after the explicit final apply action. Already-applied reviews write selected reversions only after the explicit final revert action. Comparisons without destinations never write source files. Ending a review without applying records completion without writing a Markdown file.

The server constructs output from the exact source blocks, preserving line endings and the absence of a final newline. It checks the destination version before writing. If the destination changed, the write is blocked; only an explicit refresh replaces the relevant snapshot and carries forward decisions for unchanged blocks. A comparison can become a new proposal only after the user names a destination matching the frozen before version.

The comparison route reuses the native rendered editor and suggestion rail through a controlled, read-only adapter. It builds display documents at complete Markdown block boundaries, explicitly linking source changes when one rendered block contains several. Display choices map back to persisted source IDs; rich-text serialization never participates in a destination write. Native comments and replies live in the review record. Refresh preserves historical feedback even when its source anchor disappears, presenting detached threads as document feedback. Resolved changes show their selected content; showing reviewed changes restores the original highlights and controls.

Within a source group, rendered nodes are aligned so unchanged blocks and inline text appear once. Word-level differences and formatting/attribute changes receive native marks; structural changes receive block highlights. This display refinement does not split or reset persisted source decisions. A sticky header keeps mode, navigation, save/conflict status and the explicit final action available while scrolling; it uses the same write guards as the rest of the review.

## Consequences

Comparison records must be preserved along with other application data. They contain source text and review comments, so their filesystem access follows the application's local-file trust model. They are not a global document index, collaboration service, or version-control database.

Agents can consume the complete record through the comparison API or CLI JSON output, including whether a file was actually written. CLI waiting polls durable completion rather than relying on an in-memory event. A timeout never implies approval. Source preparation, commits, skill installation, and deployments remain explicit operations outside the comparison review.

## Single editor amendment

File editing and comparisons use the same rendered editor. A comparison begins with no selected file. Reading, commenting and suggesting are available immediately. Editing and a first Keep/Revert decision require a file: the old input, the new input, or a new file seeded from one of them. Keep selects New for one passage; Revert selects Old. A no-op decision persists in the review without rewriting the selected file.

Direct edits and text-changing decisions autosave to the selected file after a version check. Save As requires inspection and explicit replacement of existing files, switches the active file, and retains the in-session undo history. Undo and redo write to the current file. A write conflict preserves the working text and pauses writes. Comments, pending suggestions, recovery text and review decisions live in the server's `comparisons/` sidecar; no adjacent metadata files are needed. Copy and Download exclude pending suggestions and comments. Comment history is separate from document history.

Send feedback freezes the current text, reference, comments and saved status. It does not authorize an agent to write. Existing comparison links and the original inline CriticMarkup editor remain supported.

## Agent review workflow amendment

This amendment supersedes the initial file chooser, Save As, and mandatory Send feedback behavior in the single editor amendment above. Legacy comparison and inline CriticMarkup links retain their existing behavior.

The invoking agent supplies a title understandable outside the project, friendly version labels, and an explicit autosave path or `none`. The review request stays in the agent conversation. Actual source paths remain separate from labels, are available on hover and in keyboard-accessible file details, and determine relative-link resolution. The compact header uses a quiet saved icon, an Edit/Suggest dropdown and an icon Markdown toggle. Errors and conflicts remain visible.

Creation binds the selected destination using existing version guards. It can be an input or a new output seeded from Old or New (default New). An existing unrelated output cannot be overwritten implicitly. Comparisons without an explicit choice default to `none` for compatibility; direct `edit FILE` defaults to that explicit file. With `none`, document edits and decisions remain available and persist in the sidecar without file writes or destination prompts. The normal UI has no Save As or destination chooser. Existing guarded save/fork APIs remain available to integrations.

New unified reviews default to `handoff: chat`. Edits, comment drafts, suggestions and decisions persist continuously. The CLI returns the URL and ID immediately. `comparison ID --read --json` reads the latest stored review without launching a browser, freezing a snapshot or completing a review. Returning to chat is the normal handoff. An explicitly requested `--watch` uses `handoff: button` and the existing Send feedback snapshot. Old persisted records missing handoff normalize to button so an already-waiting integration still works. Changing handoff on an existing review is an explicit revision-guarded operation.

Review-only persistence and file autosave are distinct. Source conflicts pause file writes while preserving the draft; concurrent review revisions never silently overwrite another browser's feedback. Preserve this review creates a durable detached review with comments, suggestions and decisions, without a Markdown file. Reading the original review includes all recovered descendants as a flat `recoveredReviews` list. An identical already-saved sync snapshot is acknowledged rather than misreported as a second browser conflict. Small pending sync requests may finish when the tab closes; browser recovery remains necessary for large drafts or a network failure. Reading feedback never implies authorization to apply suggestions or deploy source.

## Verified review link amendment

A review ID is scoped to its server's persisted review store. The complete review URL is the agent handoff handle: read, reopen and explicit watch can derive the original server and ID from that URL without discovering or starting another server. Bare IDs remain supported for existing local workflows.

Before emitting a successful browser link, the CLI verifies the saved review through the final public address, confirms its association with the selected app instance, and checks the application route. Different development frontend/API origins are allowed when they reach the same app. An invalid public alias or an unreachable document is a failed handoff even if the app is otherwise healthy.

Creation and public verification have separate failure outcomes. If the review was created but its browser link could not be verified, retain it and return a non-success result with its ID and actual server for recovery. Do not publish a success event, automatically create a duplicate, discard the review, or silently change the intended destination.

## Complete review workflow amendment

The unified editor separates interaction (Read, Edit, Suggest) from outcome view (Changes, All rejected, All accepted). Browser preferences are scoped to a review and survive refresh. Outcome views run the same decision algorithm as bulk actions in detached editor state; they never dispatch to the live editor or save queue. They include prior review decisions when the passage is still safely restorable. YAML fields form one reviewable metadata change with durable decisions and reopening. Body and metadata choices share the same bulk/preview outcome. Relative assets in an outcome use the corresponding input path, with the working path as fallback. Copy and Download export the visible outcome while previewing, and the clean working draft otherwise.

Reviewed decisions persist in the sidecar as guarded before/after passage snapshots, independent of the in-session undo stack. Their positions map through unrelated edits. A newer edit to the affected passage makes reopening unavailable rather than overwriting that edit. Overlapping reference changes and native suggestions decided together share one archive entry, so their restoration remains coherent. Outcome previews identify older decisions that can no longer be replayed safely.

Markdown source is a full editing surface in Edit and read-only in Read, Suggest and outcome views. Source edits retain their chosen spelling, update the rendered document, and synchronize YAML and represented comments. Detached feedback remains in the sidecar. Source and rich-text edits share document undo; source-origin metadata restores with its document transaction. Read-only source previews use a separate editor, and external value synchronization never enters editable source history. The formatted read-only document remains focusable so clicking it cannot leave keyboard input on the mode dropdown.
