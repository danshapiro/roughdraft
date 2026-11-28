/// <reference types="vite/client" />

declare module "virtual:roughdraft-deferred-entries" {
  export const comparisonEntryUrl: string;
  export const documentsEntryUrl: string;
  export const markdownEntryUrl: string;
}

declare module "@joplin/turndown-plugin-gfm" {
  export const tables: unknown;
  export const taskListItems: unknown;
}
