import fs from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
  gzipSync,
} from "node:zlib";
import express, { type Response } from "express";
import { expect, test } from "vitest";
import { createApp } from "./index";
import { jsonCompression, synchronousJsonLimit } from "./json-compression";

const scratch = fileURLToPath(new URL("../../../.test-tmp/", import.meta.url));

test("a bounded JSON reply reaches the transport before another synchronous request can block its compression callback", async () => {
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, "json-compression-"));
  // A genuine API response large enough to negotiate compression. Its path
  // is metadata only; the status endpoint does not read this directory.
  const projectDir = path.join(directory, "project".repeat(180));
  const host = createApp({ homeDir: directory, projectDir });
  const socket = new PassThrough();
  const request = new IncomingMessage(socket);
  request.method = "GET";
  request.url = "/api/status";
  request.headers = { "accept-encoding": "br" };
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve) =>
    response.once("finish", resolve),
  );
  try {
    host.app(request, response);
    const immediatelyWritten = chunks.length > 0;
    await finished;
    expect(response.getHeader("Content-Encoding")).toBe("br");
    expect(immediatelyWritten).toBe(true);
    const wire = Buffer.concat(chunks);
    const body = wire.subarray(wire.indexOf("\r\n\r\n") + 4);
    expect(JSON.parse(brotliDecompressSync(body).toString()).projectDir).toBe(
      projectDir,
    );
  } finally {
    host.dispose();
    socket.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function reply(
  body: unknown,
  options: {
    accept?: string;
    method?: string;
    etag?: string;
    headers?: Record<string, string>;
    type?: string;
    raw?: Buffer;
    stream?: boolean;
  } = {},
) {
  const app = express();
  app.use(jsonCompression());
  app.all("/fixture", (_request, response) => {
    response.vary("Origin");
    for (const [key, value] of Object.entries(options.headers ?? {}))
      response.setHeader(key, value);
    if (options.type) response.type(options.type);
    if (options.stream) {
      response.write(options.raw);
      response.end();
    } else if (options.raw) response.send(options.raw);
    else response.json(body);
  });
  const socket = new PassThrough();
  socket.resume();
  const request = new IncomingMessage(socket);
  request.method = options.method ?? "GET";
  request.url = "/fixture";
  request.headers = {
    ...(options.accept ? { "accept-encoding": options.accept } : {}),
    ...(options.etag ? { "if-none-match": options.etag } : {}),
  };
  const response = new ServerResponse(request);
  response.assignSocket(socket);
  const bodyChunks: Buffer[] = [];
  const record = (chunk: unknown, encoding: unknown) => {
    if (typeof chunk === "string")
      bodyChunks.push(
        Buffer.from(
          chunk,
          typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
        ),
      );
    else if (Buffer.isBuffer(chunk)) bodyChunks.push(chunk);
  };
  for (const name of ["write", "end"] as const) {
    const original = response[name];
    response[name] = function (this: Response, ...args: unknown[]) {
      record(args[0], args[1]);
      return Reflect.apply(original, this, args);
    } as (typeof response)[typeof name];
  }
  const finished = new Promise<void>((resolve) =>
    response.once("finish", resolve),
  );
  try {
    app(request, response);
    const synchronous = bodyChunks.length > 0;
    await finished;
    return {
      synchronous,
      body: Buffer.concat(bodyChunks),
      headers: response.getHeaders(),
      status: response.statusCode,
    };
  } finally {
    socket.destroy();
  }
}

const payload = {
  text: "Preserve the exact source and its feedback. ✓\n".repeat(100),
};

test.each([
  ["br", brotliDecompressSync],
  ["gzip", gunzipSync],
  ["deflate", inflateSync],
] as const)("bounded %s JSON preserves bytes, validators and existing Vary headers", async (encoding, decompress) => {
  const plain = await reply(payload);
  const encoded = await reply(payload, { accept: encoding });
  expect(encoded.synchronous).toBe(true);
  expect(encoded.headers["content-encoding"]).toBe(encoding);
  expect(decompress(encoded.body)).toEqual(plain.body);
  expect(encoded.headers.etag).toBe(plain.headers.etag);
  expect(encoded.headers.vary).toContain("Origin");
  expect(encoded.headers.vary).toContain("Accept-Encoding");
  expect(Number(encoded.headers["content-length"])).toBe(encoded.body.length);
});

test("only bounded bodies use synchronous compression; larger JSON keeps the streaming path", async () => {
  const atBound = { text: "x".repeat(synchronousJsonLimit - 11) };
  expect(Buffer.byteLength(JSON.stringify(atBound))).toBe(synchronousJsonLimit);
  const bounded = await reply(atBound, { accept: "br" });
  expect(bounded.synchronous).toBe(true);
  expect(JSON.parse(brotliDecompressSync(bounded.body).toString())).toEqual(
    atBound,
  );
  const aboveBound = { text: `${atBound.text}x` };
  const large = await reply(aboveBound, { accept: "br" });
  expect(large.synchronous).toBe(false);
  expect(large.headers["content-encoding"]).toBe("br");
  expect(JSON.parse(brotliDecompressSync(large.body).toString())).toEqual(
    aboveBound,
  );
});

test("HEAD, not-modified, no-transform, existing encoding and small replies retain their existing HTTP behavior", async () => {
  const plain = await reply(payload);
  const head = await reply(payload, { accept: "br", method: "HEAD" });
  expect(head.body).toHaveLength(0);
  expect(head.headers.etag).toBe(plain.headers.etag);
  expect(head.headers["content-encoding"]).toBeUndefined();
  const unchanged = await reply(payload, {
    accept: "br",
    etag: String(plain.headers.etag),
  });
  expect(unchanged.status).toBe(304);
  expect(unchanged.body).toHaveLength(0);
  expect(unchanged.headers["content-encoding"]).toBeUndefined();
  const untouched = await reply(payload, {
    accept: "br",
    headers: { "Cache-Control": "private, no-transform" },
  });
  expect(untouched.body).toEqual(plain.body);
  expect(untouched.headers["content-encoding"]).toBeUndefined();
  const existing = gzipSync(plain.body);
  const encoded = await reply(null, {
    accept: "br",
    raw: existing,
    type: "application/json",
    headers: { "Content-Encoding": "gzip" },
  });
  expect(encoded.body).toEqual(existing);
  expect(encoded.headers["content-encoding"]).toBe("gzip");
  const small = await reply({ status: "retry-later" }, { accept: "br" });
  expect(small.headers["content-encoding"]).toBeUndefined();
});

test("quality exclusions, identity, binary assets and event streams are respected", async () => {
  const gzip = await reply(payload, {
    accept: "br;q=0.5,gzip;q=1,identity;q=0",
  });
  expect(gzip.headers["content-encoding"]).toBe("gzip");
  const identity = await reply(payload, {
    accept: "br;q=0,gzip;q=0,deflate;q=0,identity;q=1",
  });
  expect(identity.headers["content-encoding"]).toBeUndefined();
  expect(identity.body).toEqual(Buffer.from(JSON.stringify(payload)));
  const bytes = Buffer.from("Image bytes stay byte-identical.".repeat(100));
  const image = await reply(null, {
    accept: "br",
    raw: bytes,
    type: "image/png",
  });
  expect(image.body).toEqual(bytes);
  expect(image.headers["content-encoding"]).toBeUndefined();
  const events = Buffer.from(`data: ${JSON.stringify(payload)}\n\n`);
  const stream = await reply(null, {
    accept: "br",
    raw: events,
    type: "text/event-stream",
    stream: true,
  });
  expect(stream.synchronous).toBe(true);
  expect(stream.body).toEqual(events);
  expect(stream.headers["content-encoding"]).toBeUndefined();
});
