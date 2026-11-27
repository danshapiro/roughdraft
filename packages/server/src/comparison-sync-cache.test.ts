import { expect, test } from "vitest";
import { ReviewReservations } from "./comparison-sync-cache.js";

test("remaining merge time decreases without renewing the turn and expires within750ms", () => {
  let now = 1000;
  const turns = new ReviewReservations(() => now);
  const first = turns.request("review", "a", 2);
  expect(first?.expiresAt).toBe(1750);
  expect(turns.remaining("review")).toBe(750);
  expect(turns.blocked("review", "b")).toBe(true);
  now = 1200.4;
  expect(turns.remaining("review")).toBe(550);
  expect(turns.request("review", "a", 2)).toBe(first);
  expect(first?.expiresAt).toBe(1750);
  now = 1749.5;
  expect(turns.remaining("review")).toBe(1);
  now = 1750;
  expect(turns.remaining("review")).toBe(0);
  expect(turns.valid("review", "a", first?.token, 2)).toBe(false);
  expect(turns.request("review", "a", 2)).toBeNull();
  const next = turns.request("review", "b", 2);
  expect(next?.expiresAt).toBe(2500);
  expect(turns.remaining("review")).toBe(750);
  turns.release("review", "b");
  expect(turns.remaining("review")).toBe(0);
});
