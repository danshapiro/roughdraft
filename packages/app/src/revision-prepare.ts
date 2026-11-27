import { EditorView as CodeMirrorView } from "@codemirror/view";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { cleanSourceFromNode } from "./revision-clean-cache";
import { parseRemoteRevision } from "./revision-remote-source";
import type { RevisionDraft } from "./revision-session";

export function prepareRevisionEditorDraft(
  draft: RevisionDraft,
  editor: Editor,
  options?: { beforeReflection?: boolean },
): RevisionDraft | null {
  if (options?.beforeReflection) {
    if (editor.isDestroyed || editor.view.composing) return null;
    const active = document.activeElement;
    const sourceHost =
      active instanceof HTMLElement ? active.closest(".cm-editor") : null;
    const source =
      sourceHost instanceof HTMLElement
        ? CodeMirrorView.findFromDOM(sourceHost)
        : null;
    // Source changes normally reach the document synchronously. During native
    // composition its DOM can still hold text not delivered to that callback.
    // Private reply composition does not change the public document candidate.
    if (source?.composing || source?.compositionStarted) return null;
  }
  return prepareRevisionDraft(draft, editor.state);
}

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
