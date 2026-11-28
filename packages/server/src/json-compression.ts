import {
  brotliCompressSync,
  constants,
  deflateSync,
  gzipSync,
} from "node:zlib";
import compression from "compression";
import type { RequestHandler, Response } from "express";
import { logServerEvent } from "./diagnostics.js";

// Covers two source strings (about 230 KiB with feedback) in the qualified
// 100 KiB save path. Larger responses retain streaming work.
export const synchronousJsonLimit = 256 * 1024;
const threshold = 1024;
const jsonType = /^application\/(?:[\w.+-]*\+)?json(?:;|$)/i;
const noTransform = /(?:^|,)\s*no-transform\s*(?:,|$)/i;

/** Keep bounded interactive replies out of the compression callback queue. */
export function jsonCompression(): RequestHandler {
  const streaming = compression({
    threshold,
    level: 1,
    filter: (request, response) =>
      jsonType.test(String(response.getHeader("Content-Type") ?? "")) &&
      compression.filter(request, response),
  });
  return (request, response, next) => {
    const rawEnd = response.end;
    streaming(request, response, () => {
      const streamedEnd = response.end;
      response.end = function (
        this: Response,
        chunk?: unknown,
        encoding?: BufferEncoding | (() => void),
        callback?: () => void,
      ) {
        const existingEncoding = this.getHeader("Content-Encoding");
        if (
          !this.headersSent &&
          request.method !== "HEAD" &&
          this.statusCode >= 200 &&
          this.statusCode !== 204 &&
          this.statusCode !== 304 &&
          request.get("Accept-Encoding") &&
          jsonType.test(String(this.getHeader("Content-Type") ?? "")) &&
          !noTransform.test(String(this.getHeader("Cache-Control") ?? "")) &&
          (existingEncoding === undefined || existingEncoding === "identity") &&
          (typeof chunk === "string" || Buffer.isBuffer(chunk))
        ) {
          const format = typeof encoding === "string" ? encoding : "utf8";
          const length =
            typeof chunk === "string"
              ? Buffer.byteLength(chunk, format)
              : chunk.length;
          if (length >= threshold && length <= synchronousJsonLimit) {
            const method = request.acceptsEncodings([
              "br",
              "gzip",
              "deflate",
              "identity",
            ]);
            if (method && method !== "identity") {
              let encoded: Buffer;
              try {
                const bytes =
                  typeof chunk === "string"
                    ? Buffer.from(chunk, format)
                    : chunk;
                encoded =
                  method === "br"
                    ? brotliCompressSync(bytes, {
                        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
                      })
                    : method === "gzip"
                      ? gzipSync(bytes, { level: 1 })
                      : deflateSync(bytes, { level: 1 });
              } catch (error) {
                logServerEvent(
                  "server",
                  "json-compression.fallback",
                  {
                    encoding: method,
                    bytes: length,
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                  "warn",
                );
                return Reflect.apply(streamedEnd, this, [
                  chunk,
                  encoding,
                  callback,
                ]);
              }
              // Express has already computed its ETag and conditional status
              // from the original bytes. Replace transport bytes only.
              this.vary("Accept-Encoding");
              this.setHeader("Content-Encoding", method);
              this.setHeader("Content-Length", encoded.length);
              return Reflect.apply(rawEnd, this, [
                encoded,
                typeof encoding === "function" ? encoding : callback,
              ]);
            }
          }
        }
        return Reflect.apply(streamedEnd, this, [chunk, encoding, callback]);
      };
      next();
    });
  };
}
