import { deferredComponent } from "./deferred-component";
import { markdownEntryUrl } from "virtual:roughdraft-deferred-entries";
import { optionalModule } from "./optional-module";

export const MarkdownCodeEditor = deferredComponent(
  async (attempt) => ({
    default: (
      await optionalModule(
        () => import("./MarkdownCodeEditor"),
        markdownEntryUrl,
        attempt,
      )
    ).MarkdownCodeEditor,
  }),
  "Markdown editor",
);
