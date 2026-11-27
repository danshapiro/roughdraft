import { EventEmitter } from "node:events";
import type { Response } from "express";
import { describe, expect, it } from "vitest";
import { ComparisonEventStream } from "./comparison-event-stream.js";

class SlowResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  accept = false;
  writes: string[] = [];
  write(value: string) {
    this.writes.push(value);
    return this.accept;
  }
  end() {
    this.writableEnded = true;
  }
}
describe("bounded review event hints", () => {
  it("coalesces a suspended consumer to the newest hint per review and stops on close", () => {
    const response = new SlowResponse();
    const stream = new ComparisonEventStream(
      response as unknown as Response,
      2,
    );
    stream.send("one", () => "first");
    for (let revision = 0; revision < 1000; revision++)
      stream.send("one", () => `revision:${revision}`);
    stream.send("two", () => "second review");
    stream.heartbeat(() => "heartbeat");
    expect(response.writes).toEqual(["first"]);
    response.accept = true;
    response.emit("drain");
    expect(response.writes).toEqual(["first", "revision:999", "second review"]);
    stream.close();
    stream.send("one", () => "closed");
    response.emit("drain");
    expect(response.writes).toHaveLength(3);
    expect(response.listenerCount("drain")).toBe(0);
  });
  it("ends the stream instead of retaining an unbounded set of notices", () => {
    const response = new SlowResponse();
    const stream = new ComparisonEventStream(
      response as unknown as Response,
      1,
    );
    stream.send("one", () => "first");
    stream.send("one", () => "one");
    stream.send("two", () => "two");
    expect(response.writableEnded).toBe(true);
    expect(response.listenerCount("drain")).toBe(0);
  });
});
