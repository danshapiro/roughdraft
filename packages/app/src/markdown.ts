import { tables, taskListItems } from "@joplin/turndown-plugin-gfm";
import { Marked, marked } from "marked";
import TurndownService from "turndown";
import { parse as parseYaml } from "yaml";
import { browserAnchorPath } from "./browser-base-path";
import { endnoteExtension } from "./endnotes";

export const rawMarkdownBlockAttribute = "data-markdown-raw-block";

export interface MarkdownOptions {
  resolveFileUrl?: (path: string) => string | null;
  resolveLinkUrl?: (path: string) => string | null;
  normalizeRelativeDestinations?: boolean;
}

export interface YamlFrontmatterSplit {
  frontmatter: string | null;
  body: string;
}

export interface YamlDocumentMetadataSplit {
  frontmatter: string | null;
  body: string;
  endmatter: string | null;
}

function isExternalUrl(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

function isInPageAnchor(path: string): boolean {
  return path.startsWith("#");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function encodeRawMarkdownBlock(markdown: string): string {
  return encodeURIComponent(markdown);
}

export function decodeRawMarkdownBlock(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function createRawMarkdownBlock(markdown: string): string {
  return `<div ${rawMarkdownBlockAttribute}="${escapeHtml(
    encodeRawMarkdownBlock(markdown),
  )}"></div>\n`;
}

/** Keep literal blocks intact while applying document-level rewrites. */
function transformOutsideCode(
  markdown: string,
  transform: (prose: string) => string,
  options: { inline?: boolean; indented?: boolean } = {},
): string {
  // Marked normalizes CRLF and omits reference definitions from its token list.
  // Use its code boundaries, but always transform slices of the original source.
  const originalOffsets = [0];
  for (let offset = 0; offset < markdown.length; offset += 1) {
    if (markdown[offset] === "\r" && markdown[offset + 1] === "\n") offset += 1;
    originalOffsets.push(offset + 1);
  }
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const ranges: Array<{ start: number; end: number }> = [];
  let tokenOffset = 0;
  for (const token of marked.lexer(normalized)) {
    const start = normalized.indexOf(token.raw, tokenOffset);
    if (start < 0) continue;
    tokenOffset = start + token.raw.length;
    let literalOffset = start;
    marked.walkTokens([token], (nested) => {
      if (nested.type !== "code" && nested.type !== "codespan") return;
      if (nested.type === "codespan" && options.inline === false) return;
      if (
        nested.type === "code" &&
        nested.codeBlockStyle === "indented" &&
        options.indented === false
      )
        return;
      let literalStart = normalized.indexOf(nested.raw, literalOffset);
      let literalEnd = literalStart + nested.raw.length;
      if (literalStart < 0 || literalEnd > tokenOffset) {
        // Nested token sources omit list indentation and blockquote prefixes.
        // Allow those prefixes between lines without excluding sibling HTML.
        const pattern = nested.raw
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\n(?!$)/g, "\n[ \\t]*(?:>[ \\t]*)*");
        const match = normalized
          .slice(literalOffset, tokenOffset)
          .match(new RegExp(pattern));
        if (!match || match.index === undefined) return;
        literalStart = literalOffset + match.index;
        literalEnd = literalStart + match[0].length;
      }
      ranges.push({ start: literalStart, end: literalEnd });
      literalOffset = literalEnd;
    });
  }
  const transformSlice = (start: number, end: number) => {
    if (start === end) return "";
    // Regex anchors must see the original line context rather than treating
    // the edge of an inline-code span as a new line or end of line.
    const prefix = start > 0 && markdown[start - 1] !== "\n" ? "x" : "";
    const suffix = end < markdown.length && markdown[end] !== "\n" ? "x" : "";
    const result = transform(prefix + markdown.slice(start, end) + suffix);
    return result.slice(prefix.length, suffix ? -1 : undefined);
  };
  let output = "";
  let sourceOffset = 0;
  for (const range of ranges) {
    const originalStart = originalOffsets[range.start];
    const originalEnd = originalOffsets[range.end];
    output += transformSlice(sourceOffset, originalStart);
    output += markdown.slice(originalStart, originalEnd);
    sourceOffset = originalEnd;
  }
  return output + transformSlice(sourceOffset, markdown.length);
}

function protectRawHtmlBlocks(markdown: string): string {
  return markdown
    .replace(
      /^[ \t]*<details\b[\s\S]*?<\/details>[ \t]*(?:\r?\n|$)/gim,
      (raw) => createRawMarkdownBlock(raw),
    )
    .replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm, (raw) =>
      createRawMarkdownBlock(raw),
    );
}

function protectIndentedCodeAfterLists(markdown: string): string {
  return markdown.replace(
    /^(?:[-*+]|\d+[.)]) [^\r\n]*(?:\r?\n)[ \t]*(?:\r?\n)(?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+/gm,
    (raw) => createRawMarkdownBlock(raw),
  );
}

function codeSpanContainsPipe(value: string): boolean {
  return /`[^`\n]*\|[^`\n]*`/.test(value);
}

function protectPipeSensitiveTables(markdown: string): string {
  const lines = markdown.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (
      !line.includes("|") ||
      !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)
    ) {
      output.push(line);
      continue;
    }

    const tableLines = [line, nextLine];
    index += 2;

    while (index < lines.length) {
      const row = lines[index] ?? "";
      if (!row.trim() || !row.includes("|")) break;
      tableLines.push(row);
      index += 1;
    }

    const raw = tableLines.join("");
    const needsProtection = raw.includes("\\|") || codeSpanContainsPipe(raw);
    output.push(needsProtection ? createRawMarkdownBlock(raw) : raw);
    index -= 1;
  }

  return output.join("");
}

export function protectRichTextRoundTripMarkdown(markdown: string): string {
  // Whole-list and whole-table protection needs the complete container, even
  // when one of its cells/items contains inline code. Literal fences remain
  // excluded from every preprocessing stage.
  const lists = transformOutsideCode(markdown, protectIndentedCodeAfterLists, {
    inline: false,
    indented: false,
  });
  const html = transformOutsideCode(lists, protectRawHtmlBlocks);
  return transformOutsideCode(html, protectPipeSensitiveTables, {
    inline: false,
  });
}

function normalizeMarkdownPath(path: string): string {
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../"))
    return path;
  return `./${path}`;
}

/** Give equivalent relative destinations the same editor mark attributes. */
export function stableMarkdownDestination(path: string): string {
  if (!path || isExternalUrl(path) || /^[/?#]/.test(path)) return path;
  return normalizeMarkdownPath(path);
}

function tableHasUnsupportedMarkdownContent(table: HTMLTableElement): boolean {
  return Boolean(
    table.querySelector(
      "blockquote, h1, h2, h3, h4, h5, h6, hr, ol, pre, table, ul",
    ),
  );
}

function getFirstTableRow(table: HTMLTableElement): HTMLTableRowElement | null {
  return table.rows.length > 0 ? table.rows[0] : null;
}

function isHeaderTableRow(row: HTMLTableRowElement | null): boolean {
  if (!row || row.cells.length === 0) return false;

  return Array.from(row.cells).every((cell) => cell.tagName === "TH");
}

function isMarkdownTableDivider(line: string | undefined): boolean {
  return Boolean(line && /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line));
}

function markdownTableDividerForCell(cell: HTMLTableCellElement): string {
  const alignment = (
    cell.getAttribute("align") ||
    cell.style.textAlign ||
    ""
  ).toLowerCase();

  if (alignment === "left") return ":---";
  if (alignment === "right") return "---:";
  if (alignment === "center") return ":---:";

  return "---";
}

function markdownTableDividerForRow(row: HTMLTableRowElement): string {
  const dividers = Array.from(row.cells).map(markdownTableDividerForCell);
  return `| ${dividers.join(" | ")} |`;
}

function resolveRenderedUrl(
  path: string,
  resolveFileUrl?: MarkdownOptions["resolveFileUrl"],
) {
  if (isExternalUrl(path) || isInPageAnchor(path)) return path;
  return resolveFileUrl?.(path) ?? path;
}

export function renderedMarkdownLinkUrl(
  path: string,
  options?: MarkdownOptions,
) {
  return browserAnchorPath(
    resolveRenderedUrl(
      path,
      (target) =>
        options?.resolveLinkUrl?.(target) ??
        options?.resolveFileUrl?.(target) ??
        null,
    ),
  );
}

export function renderedMarkdownImageUrl(
  path: string,
  options?: MarkdownOptions,
) {
  return resolveRenderedUrl(path, options?.resolveFileUrl);
}

function isYamlFrontmatterDelimiter(line: string): boolean {
  return /^(?:---|\.\.\.)[ \t]*$/.test(line.replace(/\r$/, ""));
}

function isReviewEndmatterMap(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasDocumentLevelComment(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  return Object.values(value as Record<string, unknown>).some(
    (entry) =>
      Boolean(entry) &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).body === "string" &&
      typeof (entry as Record<string, unknown>).by === "string" &&
      typeof (entry as Record<string, unknown>).at === "string" &&
      typeof (entry as Record<string, unknown>).re !== "string",
  );
}

function isRoughdraftReviewEndmatter(endmatter: string): boolean {
  const yamlText = endmatter.replace(/^---[ \t]*(?:\r\n|\n)/, "");
  let parsed: unknown;

  try {
    parsed = parseYaml(yamlText);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const record = parsed as Record<string, unknown>;
  return (
    isReviewEndmatterMap(record.comments) ||
    isReviewEndmatterMap(record.suggestions)
  );
}

export function splitYamlFrontmatter(markdown: string): YamlFrontmatterSplit {
  const openingDelimiter = markdown.match(/^---[ \t]*(?:\r\n|\n)/);
  if (!openingDelimiter) return { frontmatter: null, body: markdown };

  let lineStart = openingDelimiter[0].length;

  while (lineStart < markdown.length) {
    const nextLineBreak = markdown.indexOf("\n", lineStart);
    const lineEnd = nextLineBreak === -1 ? markdown.length : nextLineBreak + 1;
    const line = markdown.slice(
      lineStart,
      nextLineBreak === -1 ? lineEnd : lineEnd - 1,
    );

    if (isYamlFrontmatterDelimiter(line)) {
      let bodyStart = lineEnd;

      while (bodyStart < markdown.length) {
        const blankLineBreak = markdown.indexOf("\n", bodyStart);
        const blankLineEnd =
          blankLineBreak === -1 ? markdown.length : blankLineBreak + 1;
        const blankLine = markdown.slice(
          bodyStart,
          blankLineBreak === -1 ? blankLineEnd : blankLineEnd - 1,
        );

        if (blankLine.replace(/\r$/, "").trim() !== "") break;
        bodyStart = blankLineEnd;
      }

      return {
        frontmatter: markdown.slice(0, bodyStart),
        body: markdown.slice(bodyStart),
      };
    }

    lineStart = lineEnd;
  }

  return { frontmatter: null, body: markdown };
}

export function prependYamlFrontmatter(
  markdown: string,
  frontmatter?: string | null,
): string {
  return frontmatter ? `${frontmatter}${markdown}` : markdown;
}

export function splitYamlDocumentMetadata(
  markdown: string,
): YamlDocumentMetadataSplit {
  const { frontmatter, body } = splitYamlFrontmatter(markdown);
  const matches = [...body.matchAll(/\n---[ \t]*\r?\n/g)];
  const match = matches.at(-1);

  if (!match || match.index === undefined) {
    return { frontmatter, body, endmatter: null };
  }

  const endmatter = body.slice(match.index);
  const candidate = endmatter.replace(/^\n/, "");

  const precedingBody = body.slice(0, match.index);
  if (!isRoughdraftReviewEndmatter(candidate)) {
    return { frontmatter, body, endmatter: null };
  }
  if (!precedingBody.includes("{#")) {
    const yamlText = candidate.replace(/^---[ \t]*(?:\r\n|\n)/, "");
    const parsed = parseYaml(yamlText) as Record<string, unknown> | null;
    if (!hasDocumentLevelComment(parsed?.comments)) {
      return { frontmatter, body, endmatter: null };
    }
  }

  return {
    frontmatter,
    body: body.slice(0, match.index).replace(/\s*$/, "\n"),
    endmatter: candidate,
  };
}

export function appendYamlEndmatter(
  markdown: string,
  endmatter?: string | null,
): string {
  return endmatter
    ? `${markdown.replace(/\s*$/, "\n")}\n${endmatter}`
    : markdown;
}

export function createMarkedRenderer(options?: MarkdownOptions) {
  const renderer = new marked.Renderer();
  const baseRenderer = new marked.Renderer();

  renderer.code = ({ text, lang, escaped }) => {
    const language = (lang || "").match(/\S+/)?.[0];
    const content = escaped ? text : escapeHtml(text);
    const classAttr = language
      ? ` class="language-${escapeHtml(language)}"`
      : "";

    return `<pre><code${classAttr}>${content}</code></pre>\n`;
  };

  renderer.link = function ({ href, title, tokens, raw }) {
    const source = href || "";
    const rawHref = options?.normalizeRelativeDestinations
      ? stableMarkdownDestination(source)
      : source;
    const renderedHref = renderedMarkdownLinkUrl(rawHref, options);
    const text = this.parser.parseInline(tokens);
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;
    const autolinkAttr =
      !title && raw?.startsWith("<") && raw.endsWith(">")
        ? ' data-markdown-autolink="true"'
        : "";
    const externalAttr =
      isExternalUrl(rawHref) && !rawHref.startsWith("mailto:")
        ? ' target="_blank" rel="noreferrer noopener"'
        : "";

    return `<a href="${escapeHtml(renderedHref)}"${titleAttr}${markdownSrcAttr}${autolinkAttr}${externalAttr}>${text}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const source = href || "";
    const rawHref = options?.normalizeRelativeDestinations
      ? stableMarkdownDestination(source)
      : source;
    const renderedHref = renderedMarkdownImageUrl(rawHref, options);
    const alt = text || "";
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
    const markdownSrcAttr = ` data-markdown-src="${escapeHtml(rawHref)}"`;

    return `<img src="${escapeHtml(renderedHref)}" alt="${escapeHtml(alt)}"${titleAttr}${markdownSrcAttr}>`;
  };

  renderer.list = function (token) {
    const hasTaskItems = token.items.some((item) => item.task);
    if (!hasTaskItems) {
      return baseRenderer.list.call(this, token);
    }

    const items = token.items
      .map((item) => {
        const checked = item.checked ? "true" : "false";
        const inner = this.parser.parse(item.tokens, false);
        return `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
          item.checked ? ' checked="checked"' : ""
        }><span></span></label><div>${inner}</div></li>`;
      })
      .join("");

    return `<ul data-type="taskList">${items}</ul>`;
  };

  return renderer;
}

export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    bulletListMarker: "-",
    blankReplacement(_content, node) {
      if (node.hasAttribute(rawMarkdownBlockAttribute)) {
        return `\n\n${decodeRawMarkdownBlock(
          node.getAttribute(rawMarkdownBlockAttribute) ?? "",
        ).trimEnd()}\n\n`;
      }

      return (node as HTMLElement & { isBlock?: boolean }).isBlock
        ? "\n\n"
        : "";
    },
  });

  service.use(tables as Parameters<TurndownService["use"]>[0]);
  service.use(taskListItems as Parameters<TurndownService["use"]>[0]);

  service.addRule("compactListItem", {
    filter: "li",
    replacement(content, node, options) {
      const trimmed = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n(?!$)/g, "\n  ");

      let prefix = `${options.bulletListMarker} `;
      const parent = node.parentNode;
      if (parent && parent.nodeName === "OL") {
        const start = (parent as HTMLOListElement).getAttribute("start");
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }

      return (
        prefix +
        trimmed +
        (node.nextSibling && !/\n$/.test(trimmed) ? "\n" : "")
      );
    },
  });

  service.addRule("tiptapHeaderTable", {
    filter(node) {
      if (node.tagName !== "TABLE") return false;

      const table = node as HTMLTableElement;
      return (
        !tableHasUnsupportedMarkdownContent(table) &&
        isHeaderTableRow(getFirstTableRow(table))
      );
    },
    replacement(content, node) {
      const table = node as HTMLTableElement;
      const headerRow = getFirstTableRow(table);
      if (!headerRow) return content;

      const lines = content.replace(/\n+/g, "\n").trim().split("\n");
      if (lines.length === 0) return content;

      if (!isMarkdownTableDivider(lines[1])) {
        lines.splice(1, 0, markdownTableDividerForRow(headerRow));
      }

      const captionContent = table.caption?.textContent || "";
      const caption = captionContent ? `${captionContent}\n\n` : "";

      return `\n\n${caption}${lines.join("\n")}\n\n`;
    },
  });

  service.addRule("markdownAwareLinks", {
    filter: "a",
    replacement(content, node) {
      const element = node as HTMLAnchorElement;
      const href =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("href") ||
        "";
      const normalizedHref =
        isExternalUrl(href) || isInPageAnchor(href)
          ? href
          : normalizeMarkdownPath(href);
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";

      if (
        element.getAttribute("data-markdown-autolink") === "true" &&
        !titleMarkdown
      ) {
        return href.startsWith("mailto:")
          ? `<${href.slice("mailto:".length)}>`
          : `<${normalizedHref}>`;
      }

      return `[${content}](${normalizedHref}${titleMarkdown})`;
    },
  });

  service.addRule("markdownAwareImages", {
    filter: "img",
    replacement(_content, node) {
      const element = node as HTMLImageElement;
      const src =
        element.getAttribute("data-markdown-src") ||
        element.getAttribute("src") ||
        "";
      const normalizedSrc = isExternalUrl(src)
        ? src
        : normalizeMarkdownPath(src);
      const alt = element.getAttribute("alt") || "";
      const title = element.getAttribute("title");
      const titleMarkdown = title
        ? ` "${title.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        : "";
      return `![${alt}](${normalizedSrc}${titleMarkdown})`;
    },
  });

  service.addRule("markdownStrikethrough", {
    filter: (node) =>
      node.nodeName === "DEL" ||
      node.nodeName === "S" ||
      node.nodeName === "STRIKE",
    replacement(content) {
      return `~~${content}~~`;
    },
  });

  service.addRule("rawMarkdownBlock", {
    filter: (node) =>
      node.nodeType === 1 &&
      (node as HTMLElement).hasAttribute(rawMarkdownBlockAttribute),
    replacement(_content, node) {
      const encoded =
        (node as HTMLElement).getAttribute(rawMarkdownBlockAttribute) ?? "";
      return `\n\n${decodeRawMarkdownBlock(encoded).trimEnd()}\n\n`;
    },
  });

  service.addRule("endnoteReference", {
    filter: (node) => node.hasAttribute("data-endnote-ref"),
    replacement: (_content, node) =>
      `[^${node.getAttribute("data-endnote-ref")}]`,
  });
  service.addRule("endnoteDefinition", {
    filter: (node) => node.hasAttribute("data-endnote-definition"),
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const body = service
        .turndown(element.querySelector(".endnote-body")?.innerHTML ?? "")
        .trim();
      const original = decodeURIComponent(
        element.getAttribute("data-endnote-original") ?? "",
      );
      const raw = decodeURIComponent(
        element.getAttribute("data-endnote-source") ?? "",
      );
      if (
        raw &&
        normalizeBlockSpacing(body) ===
          normalizeBlockSpacing(service.turndown(original).trim())
      )
        return `\n\n${raw.trimEnd()}\n\n`;
      return `\n\n[^${element.getAttribute("data-endnote-definition")}]: ${body.replaceAll("\n", "\n    ")}\n\n`;
    },
  });
  return service;
}

const turndown = createTurndownService();

/**
 * Collapse runs of 3+ newlines to 2 and remove the blank line that
 * Turndown inserts before/after ATX headings.  This keeps block
 * separation where it matters (between consecutive paragraphs) while
 * producing a more compact output that round-trips with fewer
 * gratuitous whitespace changes.
 */
export function normalizeBlockSpacing(md: string): string {
  return transformOutsideCode(md, (prose) =>
    prose
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n\n(#{1,6} )/g, "\n$1")
      .replace(/(^#{1,6} [^\n]+)\n\n/gm, "$1\n"),
  );
}

export function toMarkdown(html: string): string {
  return normalizeBlockSpacing(`${turndown.turndown(html).trimEnd()}\n`);
}

export function toHtml(markdown: string, options?: MarkdownOptions): string {
  return new Marked(endnoteExtension()).parse(markdown, {
    async: false,
    gfm: true,
    renderer: createMarkedRenderer(options),
  }) as string;
}
