import { deferredComponent } from "./deferred-component";

export const MarkdownCodeEditor = deferredComponent(
  async () => ({
    default: (await import("./MarkdownCodeEditor")).MarkdownCodeEditor,
  }),
  "Markdown editor",
);
