import type { EditorState } from "@tiptap/pm/state";
import { cleanSourceFromNode } from "./revision-clean-cache";
import { parseRemoteRevision } from "./revision-remote-source";
import type { RevisionDraft } from "./revision-session";

/** Project one immutable candidate without reflecting it into the live editor. */
export function prepareRevisionDraft(
  draft: RevisionDraft,
  state: EditorState,
): RevisionDraft | null {
  try {
    const parsed = parseRemoteRevision(draft.markdown, state);
    const doc = parsed.doc.type.create(
      {
        ...parsed.doc.attrs,
        sourceMetadata: {
          markdown: draft.markdown,
          frontmatter: parsed.frontmatter,
          endmatter: parsed.endmatter,
        },
      },
      parsed.doc.content,
    );
    const clean = cleanSourceFromNode(
      draft.markdown,
      doc,
      new Map(draft.reviewComments.map((comment) => [comment.id, comment])),
    );
    const crlf =
      draft.markdown.includes("\r\n") &&
      !/[\r\n]/.test(draft.markdown.replaceAll("\r\n", ""));
    return {
      ...draft,
      cleanMarkdown: crlf ? clean.replace(/\r?\n/g, "\r\n") : clean,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        severity: "warning",
        component: "revision-editor",
        event: "detached-projection-unavailable",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}
