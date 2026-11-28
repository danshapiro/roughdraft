import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const directory = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL("../packages/app/dist", import.meta.url));
const assets = path.join(directory, "assets");
let count = 0;

// Compress the immutable browser assets once, at build time. Serving a review
// then costs only a file read, including in installations with little memory.
for (const entry of await fs.readdir(assets, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:js|css|svg|json)$/.test(entry.name)) continue;
  const filename = path.join(assets, entry.name);
  const source = await fs.readFile(filename);
  if (source.length < 1024) continue;
  const variants = [
    [
      "br",
      await compressBrotli(source, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }),
    ],
    ["gz", await compressGzip(source, { level: 9 })],
  ];
  for (const [extension, compressed] of variants) {
    if (compressed.length < source.length) {
      await fs.writeFile(`${filename}.${extension}`, compressed);
    }
  }
  count++;
}
console.log(`Precompressed ${count} browser assets (Brotli and gzip).`);
