import type {
  MarkedExtension,
  RendererThis,
  TokenizerThis,
  Tokens,
} from "marked";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export const noteKey = (label: string) =>
  label.trim().replace(/\s+/g, " ").toLowerCase();
export const noteId = (label: string) =>
  `endnote-${Array.from(noteKey(label), (c) => c.codePointAt(0)?.toString(16)).join("-")}`;

// A caller parsing a display projection can retain the full-document numbering.
export function endnoteExtension(
  numbers = new Map<string, number>(),
  knownDefinitions?: ReadonlySet<string>,
): MarkedExtension {
  const definitions = new Set<string>(knownDefinitions);
  const occurrences = new Map<string, number>();
  const numberFor = (label: string) => {
    const key = noteKey(label);
    const existing = numbers.get(key);
    if (existing !== undefined) return existing;
    const number = numbers.size + 1;
    numbers.set(key, number);
    return number;
  };
  return {
    extensions: [
      {
        name: "endnoteDefinition",
        level: "block",
        start: (src: string) => src.search(/^ {0,3}\[\^[^\]\r\n]+\]:/m),
        tokenizer(this: TokenizerThis, src: string) {
          const first =
            /^ {0,3}\[\^([^\]\r\n]+)\]:[ \t]*([^\r\n]*)(?:\r?\n|$)/.exec(src);
          if (!first) return;
          let raw = first[0];
          let body = `${first[2]}\n`;
          const continuation =
            /^(?:(?:[ \t]*\r?\n)*(?: {4}|\t)[^\r\n]*(?:\r?\n|$))/;
          while (true) {
            const next = continuation.exec(src.slice(raw.length));
            if (!next) break;
            raw += next[0];
            body += next[0].replace(/^(?: {4}|\t)/gm, "");
          }
          definitions.add(noteKey(first[1]));
          return {
            type: "endnoteDefinition",
            raw,
            // Marked may append a following separator newline to token.raw.
            // Preserve only the definition captured by this tokenizer.
            definitionSource: raw,
            label: first[1],
            tokens: this.lexer.blockTokens(body),
          };
        },
        renderer(this: RendererThis, token: Tokens.Generic) {
          const label = token.label as string;
          const number = numberFor(label);
          const body = this.parser.parse(token.tokens ?? []);
          return `<div data-endnote-definition="${escapeHtml(label)}" data-endnote-number="${number}" data-endnote-source="${escapeHtml(encodeURIComponent(String(token.definitionSource ?? token.raw)))}" data-endnote-original="${escapeHtml(encodeURIComponent(body))}" id="${noteId(label)}" role="doc-endnote"><span class="endnote-label" contenteditable="false">${number}.</span><div class="endnote-body">${body}</div><a href="#${noteId(label)}-ref-1" class="endnote-backlink" aria-label="Back to reference ${number}" contenteditable="false">↩</a></div>\n`;
        },
        childTokens: ["tokens"],
      },
      {
        name: "endnoteReference",
        level: "inline",
        start: (src: string) => src.indexOf("[^"),
        tokenizer(src: string) {
          const match = /^\[\^([^\]\r\n]+)\]/.exec(src);
          if (!match) return;
          const key = noteKey(match[1]);
          const occurrence = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occurrence);
          return {
            type: "endnoteReference",
            raw: match[0],
            label: match[1],
            number: definitions.has(key) ? numberFor(match[1]) : null,
            occurrence,
          };
        },
        renderer(token: Tokens.Generic) {
          const label = token.label as string;
          if (!definitions.has(noteKey(label))) return escapeHtml(token.raw);
          return `<a data-endnote-ref="${escapeHtml(label)}" data-endnote-number="${token.number}" data-endnote-occurrence="${token.occurrence}" id="${noteId(label)}-ref-${token.occurrence}" href="#${noteId(label)}" aria-label="Endnote ${token.number}">${token.number}</a>`;
        },
      },
    ],
  };
}
