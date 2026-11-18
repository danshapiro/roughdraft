import type { Editor } from "@tiptap/react";
import { ArrowUpRight, Copy, FileText, Link2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { HoverCard, HoverCardContent } from "./components/ui/hover-card";
import { noteKey } from "./endnotes";
import type { StorageBackend } from "./storage";

function safeUrl(anchor: HTMLAnchorElement) {
  try {
    // A fragment belongs to the current document, even when the asset <base>
    // points at the bot root. anchor.href has already lost the document query.
    const url = new URL(
      anchor.getAttribute("href") ?? anchor.href,
      window.location.href,
    );
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? url
      : null;
  } catch {
    return null;
  }
}

export function LinkAffordances({
  editor,
  backend,
  beforeNavigate,
  children,
}: {
  editor: Editor | null;
  backend: StorageBackend;
  beforeNavigate?: () => Promise<boolean>;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [anchor, setAnchor] = useState<HTMLAnchorElement | null>(null);
  const [excerpt, setExcerpt] = useState("");
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");
  const lastReferences = useRef(new Map<string, string>());
  const cancel = () => clearTimeout(timer.current);
  const close = () => {
    cancel();
    setAnchor(null);
  };
  const scheduleClose = () => {
    cancel();
    timer.current = setTimeout(() => setAnchor(null), 200);
  };
  // React portals bubble through this wrapper, but preview links must not
  // replace their own preview or activate the editor's link twice.
  const findAnchor = (target: EventTarget | null) => {
    const link =
      target instanceof Element
        ? target.closest<HTMLAnchorElement>("a[href]")
        : null;
    return link && root.current?.contains(link) ? link : null;
  };
  const openPreview = (link: HTMLAnchorElement | null, immediate = false) => {
    if (!link || !safeUrl(link)) return;
    cancel();
    if (link === anchor) return;
    timer.current = setTimeout(
      () => {
        setExcerpt("");
        setCopied(false);
        setAnchor(link);
      },
      immediate ? 0 : 250,
    );
  };
  useEffect(() => {
    if (!editor) return;
    // Scroll to a document fragment once its managed reading target exists.
    const hash = window.location.hash;
    let handled = false;
    const scrollToFragment = () => {
      if (!hash || handled) return;
      let id: string;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch {
        return;
      }
      const target = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>("[id]"),
      ).find((element) => element.id === id);
      if (target) {
        handled = true;
        target.scrollIntoView({ block: "center" });
      }
    };
    scrollToFragment();
    editor.on("transaction", scrollToFragment);
    return () => {
      editor.off("transaction", scrollToFragment);
      clearTimeout(timer.current);
    };
  }, [editor]);
  useEffect(() => {
    if (!anchor || anchor.hasAttribute("data-endnote-ref")) return;
    const url = safeUrl(anchor);
    const documentPath =
      url?.origin === window.location.origin
        ? url.searchParams.get("path")
        : null;
    if (!documentPath || url?.pathname !== window.location.pathname) return;
    if (!backend.getMarkdownFileAtPath) return;
    let current = true;
    void backend
      .getMarkdownFileAtPath(documentPath)
      .then((page) => {
        if (current)
          setExcerpt(
            page.content
              .replace(/^---\n[\s\S]*?\n---\n/, "")
              .replace(/[#*_`]/g, "")
              .trim()
              .slice(0, 320),
          );
      })
      .catch(() => {
        if (current)
          setExcerpt(
            "Preview unavailable. Open the link to check this document.",
          );
      });
    return () => {
      current = false;
    };
  }, [anchor, backend]);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearTimeout(timer.current);
        setAnchor(null);
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);
  const activate = async (link: HTMLAnchorElement) => {
    const url = safeUrl(link);
    if (!url) return;
    if (link.classList.contains("endnote-backlink")) {
      const label =
        link
          .closest("[data-endnote-definition]")
          ?.getAttribute("data-endnote-definition") ?? "";
      const previous = lastReferences.current.get(noteKey(label));
      if (previous) url.hash = previous;
    }
    close();
    if (
      url.hash &&
      url.origin === location.origin &&
      url.pathname === location.pathname &&
      url.search === location.search
    ) {
      let id: string;
      try {
        id = decodeURIComponent(url.hash.slice(1));
      } catch {
        return;
      }
      const target = Array.from(
        root.current?.querySelectorAll<HTMLElement>("[id]") ?? [],
      ).find((element) => element.id === id);
      if (link.hasAttribute("data-endnote-ref")) {
        lastReferences.current.set(
          noteKey(link.getAttribute("data-endnote-ref") ?? ""),
          link.id,
        );
      }
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (target instanceof HTMLAnchorElement)
        target.focus({ preventScroll: true });
      history.replaceState(null, "", url);
    } else if (url.protocol === "mailto:" || url.protocol === "tel:")
      location.assign(url.href);
    else if (link.target === "_blank" || url.origin !== location.origin)
      window.open(url.href, "_blank", "noopener,noreferrer");
    else {
      // The editor saves after a short debounce. Flush before leaving so a
      // quick edit followed by a click cannot lose the pending text.
      if (beforeNavigate && !(await beforeNavigate())) {
        setMessage("Save your changes before opening this link.");
        return;
      }
      location.assign(url.href);
    }
  };
  const url = anchor ? safeUrl(anchor) : null;
  const label =
    anchor?.getAttribute("data-markdown-src") ||
    (url ? `${url.host}${url.pathname}${url.hash}` : "");
  const isNote = anchor?.hasAttribute("data-endnote-ref");
  const note =
    isNote && anchor
      ? Array.from(
          root.current?.querySelectorAll<HTMLElement>(
            "[data-endnote-definition]",
          ) ?? [],
        ).find(
          (element) =>
            noteKey(element.getAttribute("data-endnote-definition") ?? "") ===
            noteKey(anchor.getAttribute("data-endnote-ref") ?? ""),
        )
      : null;
  const noteHtml = note?.querySelector(".endnote-body")?.innerHTML;
  return (
    <div
      ref={root}
      onMouseOverCapture={(event) => openPreview(findAnchor(event.target))}
      onMouseOutCapture={(event) => {
        const link = findAnchor(event.target);
        if (
          link &&
          !(
            event.relatedTarget instanceof Node &&
            link.contains(event.relatedTarget)
          )
        )
          scheduleClose();
      }}
      onFocusCapture={(event) => openPreview(findAnchor(event.target), true)}
      onBlurCapture={scheduleClose}
      onPointerDownCapture={(event) => {
        const link = findAnchor(event.target);
        if (link && event.button === 0 && !event.shiftKey && safeUrl(link)) {
          // Moving the editor selection can replace the anchor between down
          // and click. Keep it in place; activation still waits for the click.
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClickCapture={(event) => {
        const link = findAnchor(event.target);
        if (!link || event.button !== 0 || event.shiftKey || !safeUrl(link))
          return;
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey)
          window.open(
            safeUrl(link)?.href ?? link.href,
            "_blank",
            "noopener,noreferrer",
          );
        else void activate(link);
      }}
      onKeyDownCapture={(event) => {
        const link = findAnchor(event.target);
        if (link && event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          void activate(link);
        }
      }}
    >
      {children}
      {message && (
        <p role="status" className="mt-2 text-sm text-amber-700">
          {message}
        </p>
      )}
      <HoverCard
        open={Boolean(anchor && url)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <HoverCardContent
          anchor={anchor}
          role="dialog"
          aria-label={isNote ? "Endnote preview" : "Link preview"}
          onMouseEnter={cancel}
          onMouseLeave={scheduleClose}
          onFocusCapture={cancel}
          onBlurCapture={scheduleClose}
          onClick={(event) => {
            const link =
              event.target instanceof Element
                ? event.target.closest<HTMLAnchorElement>(
                    ".endnote-preview-body a[href]",
                  )
                : null;
            if (!link || event.button !== 0 || event.shiftKey || !safeUrl(link))
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.metaKey || event.ctrlKey)
              window.open(
                safeUrl(link)?.href ?? link.href,
                "_blank",
                "noopener,noreferrer",
              );
            else void activate(link);
          }}
        >
          <div className="mb-2 flex items-center gap-2 font-medium">
            <span aria-hidden="true">
              {isNote ? <FileText size={16} /> : <Link2 size={16} />}
            </span>
            {isNote
              ? `Endnote ${anchor?.getAttribute("data-endnote-number")}`
              : anchor?.textContent || "Link"}
          </div>
          {isNote ? (
            <div
              className="endnote-preview-body"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Cloned from the already schema-rendered editor note, never raw document HTML.
              dangerouslySetInnerHTML={{
                __html: noteHtml ?? "This endnote is unavailable.",
              }}
            />
          ) : (
            <>
              <div className="link-preview-destination">{label}</div>
              {excerpt && <p className="link-preview-excerpt">{excerpt}</p>}
            </>
          )}
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-200 pt-3 dark:border-slate-700">
            <a
              href={url?.href}
              target={anchor?.target || undefined}
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (anchor) void activate(anchor);
              }}
            >
              {isNote ? "Go to endnote" : "Open link"}
              <ArrowUpRight size={14} aria-hidden="true" />
            </a>
            {!isNote && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs"
                onClick={() => {
                  if (url)
                    void navigator.clipboard
                      .writeText(url.href)
                      .then(() => setCopied(true))
                      .catch(() =>
                        setMessage(
                          "Copy unavailable. Use the link’s context menu to copy its address.",
                        ),
                      );
                }}
              >
                <Copy size={13} aria-hidden="true" />
                {copied ? "Copied" : "Copy link"}
              </button>
            )}
          </div>
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}
