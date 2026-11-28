import fs from "node:fs/promises";
import path from "node:path";
import express, { type RequestHandler } from "express";

// Vite puts a content hash in these names. Documents and the HTML shell must
// revalidate because their URLs stay the same after an edit or deployment.
const hashedAsset = /^\/assets\/[\w.-]+-[\w-]{8,}\.[\w]+$/;
const compressibleAsset = /\.(?:js|css|svg|json)$/;
const immutable = "public, max-age=31536000, immutable";

export function staticAssets(directory: string): RequestHandler {
  const root = path.resolve(directory);
  const ordinary = express.static(root, {
    index: false,
    setHeaders(response, filename) {
      const relative = `/${path.relative(root, filename).split(path.sep).join("/")}`;
      if (hashedAsset.test(relative)) {
        response.setHeader("Cache-Control", immutable);
      }
    },
  });

  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      next();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(request.path);
    } catch {
      next();
      return;
    }
    if (!hashedAsset.test(pathname)) {
      ordinary(request, response, next);
      return;
    }

    response.vary("Accept-Encoding");
    if (
      !compressibleAsset.test(pathname) ||
      !request.get("Accept-Encoding") ||
      request.get("Range")
    ) {
      ordinary(request, response, next);
      return;
    }

    const original = path.join(root, pathname.slice(1));
    const candidates = [
      { encoding: "br", filename: `${original}.br` },
      { encoding: "gzip", filename: `${original}.gz` },
    ];
    void Promise.all(
      candidates.map(async (candidate) => {
        try {
          return (await fs.stat(candidate.filename)).isFile()
            ? candidate
            : null;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
          return null;
        }
      }),
    )
      .then((results) => {
        const available = results.filter((candidate) => candidate !== null);
        const selected = request.acceptsEncodings([
          ...available.map((candidate) => candidate.encoding),
          "identity",
        ]);
        const candidate = available.find(
          (candidate) => candidate.encoding === selected,
        );
        if (!candidate) {
          ordinary(request, response, next);
          return;
        }
        response.type(path.extname(original));
        response.setHeader("Content-Encoding", candidate.encoding);
        response.setHeader("Cache-Control", immutable);
        response.sendFile(
          path.relative(root, candidate.filename),
          { root },
          (error) => {
            if (error) {
              if (!response.headersSent) {
                response.removeHeader("Content-Encoding");
                response.removeHeader("Cache-Control");
              }
              next(error);
            }
          },
        );
      })
      .catch(next);
  };
}
