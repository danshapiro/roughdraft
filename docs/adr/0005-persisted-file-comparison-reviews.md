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

New file drafts and comparisons use the same editable document. A frozen reference and a destination are independent and optional. The stored draft includes the annotated editor document, the Markdown for Save or export, content-bound Keep choices, and separately submitted comments. Matching rendered ranges are derived from the editable document; reference highlights are decorations and never serialize. Pending suggestions are excluded from the file projection until kept.

Save writes the current projection after a destination version check. Save As requires inspection and explicit replacement of existing files. Send freezes a feedback snapshot and reports whether it matches the saved destination. It does not write or grant write permission. Automatic recovery and in-session undo are separate; document history does not undo submitted comments. Existing comparison records and their original read-only UI remain supported.
