import { expect, test } from "vitest";
import { ReviewReservations } from "./comparison-sync-cache.js";

test("a released holder cannot bypass the page already waiting for its next merge turn", () => {
  let now = 1000;
  const turns = new ReviewReservations(() => now);
  const held = turns.request("review", "a", 2);
  expect(held).not.toBeNull();
  expect(turns.blocked("review", "b")).toBe(true);

  now += 100;
  turns.release("review", "a");
  expect(turns.blocked("review", "a")).toBe(true);

  const next = turns.request("review", "b", 3);
  expect(next?.revision).toBe(3);
  expect(turns.request("review", "b", 3)).toEqual(next);
  expect(turns.blocked("review", "a", next?.token)).toBe(true);
  expect(turns.valid("review", "b", next?.token, 3)).toBe(true);
  expect(turns.blocked("review", "b", next?.token)).toBe(false);
  turns.release("review", "b");
  expect(turns.blocked("review", "a")).toBe(false);
});

test("a waiting page that closes cannot hold the next save beyond the existing 750ms turn", () => {
  let now = 1000;
  const turns = new ReviewReservations(() => now);
  turns.request("review", "a", 2);
  expect(turns.blocked("review", "b")).toBe(true);
  now += 100;
  turns.release("review", "a");

  expect(turns.blocked("review", "a")).toBe(true);
  expect(turns.remaining("review")).toBe(750);
  now += 749;
  expect(turns.blocked("review", "a")).toBe(true);
  expect(turns.remaining("review")).toBe(1);
  now += 1;
  expect(turns.blocked("review", "a")).toBe(false);
});
