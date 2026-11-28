import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const publicId = "virtual:roughdraft-deferred-entries";
const resolvedId = `\0${publicId}`;

/** Expose compiled optional entry URLs without downloading their modules. */
export function deferredEntries(
  entries: Record<string, string> = {
    markdownEntryUrl: fileURLToPath(
      new URL("./src/MarkdownCodeEditor.tsx", import.meta.url),
    ),
  },
): Plugin {
  let building = false;
  let root = "";
  return {
    name: "roughdraft-deferred-entries",
    configResolved(config) {
      building = config.command === "build";
      root = config.root;
    },
    resolveId(id) {
      return id === publicId ? resolvedId : undefined;
    },
    load(id) {
      if (id !== resolvedId) return;
      return Object.entries(entries)
        .map(([name, filename]) => {
          if (!building) {
            const relative = path
              .relative(root, filename)
              .split(path.sep)
              .join("/");
            return `export const ${name} = ${JSON.stringify(relative)};`;
          }
          const reference = this.emitFile({
            type: "chunk",
            id: filename,
            name: path.basename(filename, path.extname(filename)),
            preserveSignature: "strict",
          });
          return `export const ${name} = import.meta.ROLLUP_FILE_URL_${reference};`;
        })
        .join("\n");
    },
  };
}
