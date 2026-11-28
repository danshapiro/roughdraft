import fs from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  brotliCompressSync,
  brotliDecompressSync,
  gzipSync,
  gunzipSync,
} from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./index";

const scratchRoot = fileURLToPath(
  new URL("../../../.test-tmp/", import.meta.url),
);

describe("production static delivery", () => {
  let directory: string;
  let server: http.Server;
  let dispose: () => void;
  let port: number;
  const script = "window.review = 'A reasonably sized review script';\n".repeat(
    200,
  );

  beforeEach(async () => {
    fs.mkdirSync(scratchRoot, { recursive: true });
    directory = fs.mkdtempSync(path.join(scratchRoot, "static-delivery-"));
    fs.mkdirSync(path.join(directory, "assets"));
    fs.writeFileSync(
      path.join(directory, "index.html"),
      "<!doctype html><html><head></head><body>Review</body></html>",
    );
    fs.writeFileSync(path.join(directory, "assets/app-Abcd1234.js"), script);
    fs.writeFileSync(
      path.join(directory, "assets/app-Abcd1234.js.br"),
      brotliCompressSync(script),
    );
    fs.writeFileSync(
      path.join(directory, "assets/app-Abcd1234.js.gz"),
      gzipSync(script),
    );
    fs.writeFileSync(path.join(directory, "guide.md"), "# Mutable guide\n");
    fs.writeFileSync(
      path.join(directory, "review.md"),
      "# A larger review\n\n".repeat(1000),
    );
    const created = createApp({ staticDirPath: directory, homeDir: directory });
    dispose = created.dispose;
    server = created.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test listener");
    port = address.port;
  });

  afterEach(async () => {
    dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function get(
    url: string,
    headers: http.OutgoingHttpHeaders = {},
    method = "GET",
  ) {
    return new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    }>((resolve, reject) => {
      const request = http.request(
        { host: "127.0.0.1", port, path: url, headers, method, agent: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("error", reject);
      request.end();
    });
  }

  it("delivers Brotli script bytes without changing JavaScript MIME or source", async () => {
    const response = await get("/assets/app-Abcd1234.js?review=1", {
      "Accept-Encoding": "br, gzip;q=0.9",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers["content-type"]).toMatch(/javascript/);
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(response.body.length).toBeLessThan(Buffer.byteLength(script) / 4);
    expect(brotliDecompressSync(response.body).toString()).toBe(script);
  });

  it("honors encoding quality and gzip-only clients", async () => {
    for (const header of ["gzip", "br;q=0, gzip;q=1", "br;q=0.5, gzip;q=1"]) {
      const response = await get("/assets/app-Abcd1234.js", {
        "Accept-Encoding": header,
      });
      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(gunzipSync(response.body).toString()).toBe(script);
    }
  });

  it("honors tied client preferences, wildcard support and explicit exclusions", async () => {
    for (const [header, expected] of [
      ["br,gzip", "br"],
      ["gzip,br", "gzip"],
      ["*;q=1,identity;q=0", "br"],
      ["br;q=0,*;q=1,identity;q=0", "gzip"],
    ]) {
      const response = await get("/assets/app-Abcd1234.js", {
        "Accept-Encoding": header,
      });
      expect(response.status).toBe(200);
      expect(response.headers["content-encoding"]).toBe(expected);
      const decoded =
        expected === "br"
          ? brotliDecompressSync(response.body)
          : gunzipSync(response.body);
      expect(decoded.toString()).toBe(script);
    }
  });

  it("keeps identity clients and builds without compressed artifacts working", async () => {
    for (const header of [undefined, "identity", "br;q=0, gzip;q=0"]) {
      const response = await get(
        "/assets/app-Abcd1234.js",
        header ? { "Accept-Encoding": header } : {},
      );
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.body.toString()).toBe(script);
      expect(response.headers.vary).toContain("Accept-Encoding");
    }
    fs.rmSync(path.join(directory, "assets/app-Abcd1234.js.br"));
    fs.rmSync(path.join(directory, "assets/app-Abcd1234.js.gz"));
    const response = await get("/assets/app-Abcd1234.js", {
      "Accept-Encoding": "br,gzip",
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toBe(script);
  });

  it("caches hashed assets across visits while revalidating HTML and mutable files", async () => {
    const asset = await get("/assets/app-Abcd1234.js", {
      "Accept-Encoding": "br",
    });
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    const cached = await get("/assets/app-Abcd1234.js", {
      "Accept-Encoding": "br",
      "If-None-Match": asset.headers.etag,
    });
    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
    for (const url of ["/", "/index.html", "/guide.md"]) {
      const response = await get(url);
      expect(response.headers["cache-control"]).not.toContain("immutable");
      expect(response.headers["cache-control"]).toMatch(/no-cache|max-age=0/);
    }
  });

  it("supports HEAD and ranges without returning compressed byte slices as JavaScript", async () => {
    const head = await get(
      "/assets/app-Abcd1234.js",
      { "Accept-Encoding": "br" },
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("br");
    expect(head.body.length).toBe(0);
    const ranged = await get("/assets/app-Abcd1234.js", {
      "Accept-Encoding": "br",
      Range: "bytes=0-9",
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-encoding"]).toBeUndefined();
    expect(ranged.body.toString()).toBe(script.slice(0, 10));
  });

  it("keeps the browser base distinct and reports missing assets without HTML fallbacks", async () => {
    const html = await get("/", { "Accept-Encoding": "br" });
    expect(html.body.toString()).toContain('<base href="/">');
    const missing = await get("/assets/missing-Abcd1234.js", {
      "Accept-Encoding": "br",
    });
    expect(missing.status).toBe(404);
    expect(missing.headers["content-encoding"]).toBeUndefined();
  });

  it("builds reusable compressed assets with exactly the original bytes", () => {
    fs.rmSync(path.join(directory, "assets/app-Abcd1234.js.br"));
    fs.rmSync(path.join(directory, "assets/app-Abcd1234.js.gz"));
    fs.writeFileSync(
      path.join(directory, "assets/font-Abcd1234.woff2"),
      script,
    );
    execFileSync(process.execPath, [
      fileURLToPath(
        new URL("../../../scripts/precompress-app.mjs", import.meta.url),
      ),
      directory,
    ]);
    expect(
      brotliDecompressSync(
        fs.readFileSync(path.join(directory, "assets/app-Abcd1234.js.br")),
      ).toString(),
    ).toBe(script);
    expect(
      gunzipSync(
        fs.readFileSync(path.join(directory, "assets/app-Abcd1234.js.gz")),
      ).toString(),
    ).toBe(script);
    expect(
      fs.readFileSync(path.join(directory, "assets/app-Abcd1234.js"), "utf8"),
    ).toBe(script);
    expect(
      fs.existsSync(path.join(directory, "assets/font-Abcd1234.woff2.br")),
    ).toBe(false);
  });

  it("compresses sizable JSON while retaining source bytes and conditional requests", async () => {
    const url = `/api/markdown-file?projectPath=${encodeURIComponent(directory)}&path=review.md`;
    const plain = await get(url);
    const compressed = await get(url, { "Accept-Encoding": "gzip" });
    expect(compressed.status).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers.vary).toContain("Accept-Encoding");
    expect(gunzipSync(compressed.body).toString()).toBe(plain.body.toString());
    expect(compressed.body.length).toBeLessThan(plain.body.length / 4);
    expect(compressed.headers.etag).toBe(plain.headers.etag);
    const unchanged = await get(url, {
      "Accept-Encoding": "gzip",
      "If-None-Match": compressed.headers.etag,
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.body.length).toBe(0);
    const small = await get("/api/status", { "Accept-Encoding": "br,gzip" });
    expect(small.headers["content-encoding"]).toBeUndefined();
  });

  it("leaves event streams immediate and document image bytes untouched", async () => {
    const streamed = await new Promise<{
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) => {
      const request = http.get(
        {
          host: "127.0.0.1",
          port,
          path: "/api/open-requests",
          headers: { "Accept-Encoding": "gzip,br" },
          agent: false,
        },
        (response) => {
          response.once("data", (chunk) => {
            resolve({ headers: response.headers, body: chunk.toString() });
            response.destroy();
            request.destroy();
          });
          response.on("error", reject);
        },
      );
      request.on("error", reject);
    });
    expect(streamed.headers["content-type"]).toBe("text/event-stream");
    expect(streamed.headers["content-encoding"]).toBeUndefined();
    expect(streamed.headers["cache-control"]).toContain("no-transform");
    expect(streamed.body).toContain("event: connected");
    fs.writeFileSync(path.join(directory, "image.svg"), `<svg>${script}</svg>`);
    const image = await get(
      `/api/files?projectPath=${encodeURIComponent(directory)}&path=image.svg`,
      { "Accept-Encoding": "gzip,br" },
    );
    expect(image.status).toBe(200);
    expect(image.headers["content-encoding"]).toBeUndefined();
    expect(image.body.toString()).toBe(`<svg>${script}</svg>`);
  });
});
