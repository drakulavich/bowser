// Unit tests for the daemon's request-serialization primitives.
import { describe, expect, test } from "bun:test";
import { createSerializer, withTimeout } from "../src/serialize.ts";

describe("createSerializer", () => {
  test("runs tasks strictly one at a time, in submission order", async () => {
    const serialize = createSerializer();
    const events: string[] = [];
    const mk = (id: string, delay: number) => () =>
      new Promise<void>((r) => {
        events.push(`start:${id}`);
        setTimeout(() => { events.push(`end:${id}`); r(); }, delay);
      });
    // A is slow, B is fast — B must NOT start until A has ended.
    const a = serialize(mk("A", 30));
    const b = serialize(mk("B", 0));
    await Promise.all([a, b]);
    expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);
  });

  test("a rejecting task does not break the chain", async () => {
    const serialize = createSerializer();
    const boom = serialize(() => Promise.reject(new Error("boom")));
    await expect(boom).rejects.toThrow("boom");
    expect(await serialize(() => Promise.resolve("ok"))).toBe("ok");
  });

  test("returns the task's resolved value", async () => {
    const serialize = createSerializer();
    expect(await serialize(() => Promise.resolve(42))).toBe(42);
  });

  test("separate serializers are independent (concurrent across, serial within)", async () => {
    const s1 = createSerializer();
    const s2 = createSerializer();
    const events: string[] = [];
    const mk = (id: string, delay: number) => () =>
      new Promise<void>((r) => { events.push(`start:${id}`); setTimeout(() => { events.push(`end:${id}`); r(); }, delay); });
    // s1 runs A then B serially; s2 runs C concurrently with s1's work.
    await Promise.all([s1(mk("A", 20)), s1(mk("B", 0)), s2(mk("C", 0))]);
    // Within s1, A fully precedes B:
    expect(events.indexOf("end:A")).toBeLessThan(events.indexOf("start:B"));
    // C (on s2) is not blocked behind A (on s1): it ends before A does.
    expect(events.indexOf("end:C")).toBeLessThan(events.indexOf("end:A"));
  });
});

describe("withTimeout", () => {
  test("resolves a fast promise", async () => {
    expect(await withTimeout(Promise.resolve("v"), 1000, "op")).toBe("v");
  });

  test("rejects a slow promise with the label in the message", async () => {
    const slow = new Promise((r) => setTimeout(r, 50));
    await expect(withTimeout(slow, 5, "evaluate")).rejects.toThrow(/operation 'evaluate' timed out/);
  });

  test("passes the promise through unchanged when ms <= 0", async () => {
    expect(await withTimeout(Promise.resolve("v"), 0, "op")).toBe("v");
  });

  test("propagates a rejection from p (not a timeout error)", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("inner")), 1000, "op"),
    ).rejects.toThrow("inner");
  });
});
