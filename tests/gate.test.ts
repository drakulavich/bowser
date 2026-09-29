import { describe, expect, test } from "bun:test";

import { createGate } from "../src/daemon/gate.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = (p: Promise<unknown>) => Bun.peek.status(p);

describe("gate", () => {
  test("a second connection waits until the first leaves", async () => {
    const gate = createGate(0);
    const a = {};
    const b = {};
    (await gate.enter(a))();
    const bEnter = gate.enter(b);
    await tick();
    expect(status(bEnter)).toBe("pending");
    gate.leave(a);
    await bEnter;
  });

  test("the holder's own requests enter at once and in order", async () => {
    const gate = createGate(0);
    const a = {};
    const order: number[] = [];
    const p1 = gate.enter(a).then(() => order.push(1));
    const p2 = gate.enter(a).then(() => order.push(2));
    const p3 = gate.enter(a).then(() => order.push(3));
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("waiters are served in arrival order", async () => {
    const gate = createGate(0);
    const [a, b, c] = [{}, {}, {}];
    (await gate.enter(a))();
    const bEnter = gate.enter(b);
    const cEnter = gate.enter(c);
    gate.leave(a);
    (await bEnter)();
    await tick();
    expect(status(cEnter)).toBe("pending");
    gate.leave(b);
    await cEnter;
  });

  test("a holder is released only after its entered requests are done", async () => {
    const gate = createGate(0);
    const a = {};
    const b = {};
    const done1 = await gate.enter(a);
    const done2 = await gate.enter(a);
    const bEnter = gate.enter(b);
    gate.leave(a);
    await tick();
    expect(status(bEnter)).toBe("pending");
    done1();
    await tick();
    expect(status(bEnter)).toBe("pending");
    done2();
    await bEnter;
  });

  test("an idle holder loses the gate after idleMs", async () => {
    const gate = createGate(50);
    const a = {};
    const b = {};
    (await gate.enter(a))();
    const bEnter = gate.enter(b);
    await tick();
    expect(status(bEnter)).toBe("pending");
    await sleep(60);
    const doneB = await bEnter;
    const aAgain = gate.enter(a);
    await sleep(120);
    expect(status(aAgain)).toBe("pending");
    doneB();
    gate.leave(b);
    await aAgain;
  });

  test("a busy holder is never idled out", async () => {
    const gate = createGate(50);
    const a = {};
    const b = {};
    await gate.enter(a);
    const bEnter = gate.enter(b);
    await sleep(150);
    expect(status(bEnter)).toBe("pending");
  });

  test("a waiter that leaves before its turn is dropped", async () => {
    const gate = createGate(0);
    const [a, b, c] = [{}, {}, {}];
    const doneA = await gate.enter(a);
    const bEnter = gate.enter(b);
    const cEnter = gate.enter(c);
    gate.leave(b);
    await expect(bEnter).rejects.toThrow();
    await tick();
    expect(status(cEnter)).toBe("pending");
    doneA();
    gate.leave(a);
    await cEnter;
  });

  test("idleMs 0 never releases an idle holder", async () => {
    const gate = createGate(0);
    const a = {};
    const b = {};
    (await gate.enter(a))();
    const bEnter = gate.enter(b);
    await sleep(100);
    expect(status(bEnter)).toBe("pending");
  });
});
