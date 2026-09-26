// F36: the MCP server's line loop. A slow tools/call must not hold up ping,
// the handshake, or a call to another session; calls to one session keep their
// order; notifications/cancelled drops the call's response. Driven through
// createMcpServer (the loop runMcpServer wraps around stdin/stdout) with a
// fake `run` whose calls the test releases one by one.

import { describe, expect, test } from "bun:test";

import { createMcpServer, type McpDeps } from "../src/mcp.ts";

interface Call {
  session: string;
  expr: string;
  release: (out?: string) => void;
}

/** A fake `run` that parks every call until the test releases it, plus the
 *  server wired to it and a log of every stdout write. */
function harness() {
  const started: Call[] = [];
  const writes: string[] = [];
  const deps: McpDeps = {
    version: "9.9.9",
    run: (argv) =>
      new Promise<string>((resolve) => {
        const s = argv.indexOf("--session");
        const session = s >= 0 ? argv[s + 1]! : "default";
        const expr = argv[argv.indexOf("--") + 1]!;
        started.push({ session, expr, release: (out) => resolve(out ?? `{"result":${JSON.stringify(expr)}}`) });
      }),
  };
  const server = createMcpServer(deps, (line) => writes.push(line));
  const send = (msg: object) => server.accept(JSON.stringify(msg));
  const call = (id: number, expr: string, session?: string) =>
    send({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "eval", arguments: session ? { expression: expr, session } : { expression: expr } },
    });
  const cancel = (requestId: number) =>
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "test" } });
  const responses = () => writes.map((w) => JSON.parse(w));
  const ids = () => responses().map((r) => r.id);
  return { server, started, writes, send, call, cancel, responses, ids };
}

/** Let queued microtasks and promise chains run. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("MCP server: a slow call blocks nothing else", () => {
  test("ping, initialize and tools/list are answered while a call hangs", async () => {
    const h = harness();
    h.call(1, "hang", "A");
    await tick();
    h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    h.send({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
    h.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await tick();
    expect(h.ids()).toEqual([2, 3, 4]);
    h.started[0]!.release();
    await h.server.idle();
    expect(h.ids()).toEqual([2, 3, 4, 1]);
  });

  test("a call to session B completes while a call to A hangs", async () => {
    const h = harness();
    h.call(1, "hang", "A");
    h.call(2, "quick", "B");
    await tick();
    expect(h.started.map((c) => c.session)).toEqual(["A", "B"]);
    h.started[1]!.release();
    await tick();
    expect(h.ids()).toEqual([2]);
    h.started[0]!.release();
    await h.server.idle();
    expect(h.ids()).toEqual([2, 1]);
  });

  test("a call without a session is keyed to the default session, like the CLI", async () => {
    const h = harness();
    h.call(1, "first");
    h.call(2, "second", "default");
    h.call(3, "other", "B");
    await tick();
    // The explicit "default" waits behind the implicit one; B does not.
    expect(h.started.map((c) => c.expr)).toEqual(["first", "other"]);
    h.started[0]!.release();
    await tick();
    expect(h.started.map((c) => c.expr)).toEqual(["first", "other", "second"]);
    h.started[1]!.release();
    h.started[2]!.release();
    await h.server.idle();
  });
});

describe("MCP server: calls to one session keep their order", () => {
  test("the second call to A starts only after the first finished", async () => {
    const h = harness();
    h.call(1, "one", "A");
    h.call(2, "two", "A");
    await tick();
    expect(h.started.map((c) => c.expr)).toEqual(["one"]);
    h.started[0]!.release();
    await tick();
    expect(h.started.map((c) => c.expr)).toEqual(["one", "two"]);
    h.started[1]!.release();
    await h.server.idle();
    expect(h.ids()).toEqual([1, 2]);
  });
});

describe("MCP server: notifications/cancelled", () => {
  test("a cancelled queued call never runs and gets no response", async () => {
    const h = harness();
    h.call(1, "one", "A");
    h.call(2, "two", "A");
    h.call(3, "three", "A");
    await tick();
    h.cancel(2);
    h.started[0]!.release();
    await tick();
    expect(h.started.map((c) => c.expr)).toEqual(["one", "three"]);
    h.started[1]!.release();
    await h.server.idle();
    expect(h.ids()).toEqual([1, 3]);
  });

  test("a cancelled running call finishes, and its result is dropped", async () => {
    const h = harness();
    h.call(1, "one", "A");
    h.call(2, "two", "A");
    await tick();
    h.cancel(1);
    await tick();
    // Still running: the daemon op is not undone, so the next call waits.
    expect(h.started.map((c) => c.expr)).toEqual(["one"]);
    h.started[0]!.release();
    await tick();
    expect(h.ids()).toEqual([]);
    expect(h.started.map((c) => c.expr)).toEqual(["one", "two"]);
    h.started[1]!.release();
    await h.server.idle();
    expect(h.ids()).toEqual([2]);
  });

  test("a cancel for an unknown or finished id changes nothing", async () => {
    const h = harness();
    h.call(1, "one", "A");
    await tick();
    h.started[0]!.release();
    await h.server.idle();
    h.cancel(1);
    h.cancel(99);
    h.call(2, "two", "A");
    await tick();
    h.started[1]!.release();
    await h.server.idle();
    expect(h.ids()).toEqual([1, 2]);
  });
});

describe("MCP server: stdout stays pure JSON-RPC", () => {
  test("every write is one whole JSON-RPC line", async () => {
    const h = harness();
    h.call(1, "one", "A");
    h.call(2, "two", "B");
    h.call(3, "three", "A");
    h.send({ jsonrpc: "2.0", id: 4, method: "ping" });
    h.server.accept("{not json");
    h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
    h.send({ jsonrpc: "2.0", id: 6, method: "bogus" });
    await tick();
    h.started[1]!.release();
    h.started[0]!.release();
    await tick();
    h.started[2]!.release();
    await h.server.idle();
    expect(h.writes.length).toBe(7);
    for (const w of h.writes) {
      expect(w.endsWith("\n")).toBe(true);
      expect(w.indexOf("\n")).toBe(w.length - 1);
      const msg = JSON.parse(w);
      expect(msg.jsonrpc).toBe("2.0");
      expect("result" in msg || "error" in msg).toBe(true);
    }
    expect(h.ids().sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([null, 1, 2, 3, 4, 5, 6]);
  });
});
