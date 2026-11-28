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

test("an unhanded turn excludes its own long journal once; replay, request and status cannot renew or revive it", () => {
  let now = 1000;
  const turns = new ReviewReservations(() => now);
  const stored = turns.request("review", "a", 2);
  if (!stored) throw new Error("Expected the first turn");
  now = 2000; // Its own durable work took longer than the preparation window.
  const delivered = turns.handOff("review", "a", stored, 1000);
  expect(delivered?.expiresAt).toBe(2750);
  expect(turns.remaining("review")).toBe(750);
  expect(stored.expiresAt).toBe(1750); // The journal's original value stays immutable.
  now = 2100;
  expect(turns.request("review", "a", 2)).toEqual(delivered);
  expect(turns.handOff("review", "a", stored, 2000)).toEqual(delivered);
  expect(turns.current("review", "a", stored)).toEqual(delivered);
  expect(turns.remaining("review")).toBe(650);
  expect(turns.current("other-review", "a", stored)).toBeNull();
  expect(turns.current("review", "b", stored)).toBeNull();
  expect(
    turns.current("review", "a", { ...stored, token: "another-token" }),
  ).toBeNull();
  expect(turns.current("review", "a", { ...stored, revision: 3 })).toBeNull();
  now = 2750;
  expect(turns.current("review", "a", stored)).toBeNull();
  expect(turns.handOff("review", "a", stored, 2000)).toBeNull();
  expect(turns.remaining("review")).toBe(0);
});

test.each([
  250, 1000,
])("a queued handoff preserves earlier waiting time while excluding %d ms of its first journal", (journalCost) => {
  let now = 1000;
  const turns = new ReviewReservations(() => now);
  turns.request("review", "a", 2);
  expect(turns.blocked("review", "b")).toBe(true);
  turns.release("review", "a");
  // The previous writer gives the queued page a turn before that page returns.
  expect(turns.blocked("review", "a")).toBe(true);
  now = 1200;
  const selected = turns.request("review", "b", 3);
  if (!selected) throw new Error("Expected the queued page's turn");
  expect(selected.expiresAt).toBe(1750);
  now += journalCost;
  const delivered = turns.handOff("review", "b", selected, 1200);
  expect(delivered?.expiresAt).toBe(1750 + journalCost);
  expect(turns.remaining("review")).toBe(550);
  now += 100;
  expect(turns.request("review", "b", 3)).toEqual(delivered);
  expect(turns.handOff("review", "b", selected, now)).toEqual(delivered);
  expect(turns.remaining("review")).toBe(450);
});

test("a turn already expired before journal work is not resurrected", () => {
  let now = 1000;
  const turns = new ReviewReservations(() => now);
  const expired = turns.request("review", "a", 2);
  if (!expired) throw new Error("Expected the original turn");
  now = 1800;
  expect(turns.handOff("review", "a", expired, 1800)).toBeNull();
  expect(turns.current("review", "a", expired)).toBeNull();
  expect(turns.request("review", "b", 2)?.expiresAt).toBe(2550);
});
