# Refactor PR 2: Typed daemon protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the daemon protocol a single typed map so the client, the server dispatcher, and the test double are all derived from it, and split `src/daemon.ts` into `src/daemon/{protocol,server,client,main}.ts`.

**Architecture:** `DaemonOps` in `protocol.ts` declares every op's argument tuple and result. `DaemonClient.request` is typed from it (no casts at call sites). The server's handler table is typed from it (a missing or mistyped handler fails `tsc`). One shared `fakeClient` in `tests/helpers/` replaces three hand-written switches. Wire format, op names, CLI output, and `--json` shapes do not change.

**Tech Stack:** Bun ≥ 1.3.12, TypeScript 7.0.2 (`bun run typecheck`), `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md` (Sections 1, 2, 5, 6; PR 2 row).

## Global Constraints

- Bun ≥ 1.3.12; zero runtime dependencies; Bun-native APIs.
- Do not change CLI output, `--json` shapes, exit codes, snapshot YAML, `state.json`, or wire op names and message shapes (`{ id, op, args }` / `{ id, ok, result | error }`). A client from this branch must talk to a daemon started from `main` and vice versa.
- Every existing test keeps its expected strings; only import paths and the fake-client construction change.
- `bun run typecheck && bun test` green after every task. `BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test` green before the PR opens; the compiled binary is smoke-tested by hand because Task 3 moves the daemon spawn path.
- The daemon serializes ops; never dispatch `handle(req)` outside the serializer except for `shutdown` (existing behavior, kept verbatim). `OP_META` / urgent routing is PR 6, not this PR.
- Commit trailer on every commit:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj`
- Branch `refactor/2-typed-protocol` from `main` (which contains PR 1). Work in a git worktree under `.worktrees/`.
- Shell resets cwd after each call; prefix commands with `cd <worktree>`.

---

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/daemon/protocol.ts` | create | `DaemonOps`, `Op`, `ArgsOf`, `ResultOf`, `RequestParams`, `DaemonRequest`, `DaemonResponse`, `DaemonConnection` |
| `src/daemon/server.ts` | create | `createHandler(browser)`, `startDaemon(session)`, `opTimeoutMs` |
| `src/daemon/client.ts` | create | `socketPath`, `DaemonClient`, `connectOrSpawn`, `spawnDaemon` |
| `src/daemon/main.ts` | create (moved) | spawn entry, today's `src/daemon-main.ts` |
| `src/daemon.ts`, `src/daemon-main.ts` | delete | replaced by the four files above |
| `src/cli.ts` | modify | `--daemon` import path |
| `src/commands.ts` | modify | import path; `DaemonConnection`; remove result casts |
| `tests/helpers/fake-client.ts` | create | one typed `fakeClient` for all command tests |
| `tests/protocol.test.ts` | create | compile-time assertions on `request` typing |
| `tests/daemon-handler.test.ts` | create | `createHandler` against a fake `Browser` |
| `tests/commands.test.ts`, `tests/cookie.test.ts`, `tests/state-storage.test.ts` | modify | use the shared fake client |
| `tests/daemon.test.ts`, `tests/e2e-search.test.ts` | modify | import path |
| `tests/layers.test.ts` | modify | rules follow the new layout |
| `CLAUDE.md`, `CHANGELOG.md`, spec | modify | paths, "Adding a command" step 1, Unreleased entry, OP_META note |

---

### Task 1: `daemon/protocol.ts` and its compile-time test

**Files:**
- Create: `src/daemon/protocol.ts`
- Create: `tests/protocol.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `interface DaemonOps` with keys exactly: `ping, shutdown, state, navigate, evaluate, click, type, press, hover, select, check, uncheck, screenshot, resize, back, forward, reload, "cookie-get-all", "cookie-set", "cookie-delete", "cookie-clear"`.
  - `type Op = keyof DaemonOps`; `type ArgsOf<O extends Op> = DaemonOps[O]["args"]`; `type ResultOf<O extends Op> = DaemonOps[O]["result"]`.
  - `type RequestParams<O extends Op> = ArgsOf<O> extends [] ? [op: O, args?: []] : [op: O, args: ArgsOf<O>]`.
  - `interface DaemonRequest { id: number; op: Op; args?: unknown[]; page?: string }` (wire shape; `page` reserved, ignored).
  - `interface DaemonResponse { id: number; ok: boolean; result?: unknown; error?: string }`.
  - `interface DaemonConnection { request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>>; close(): void }`.

- [ ] **Step 1: Write the compile-time test**

`tests/protocol.test.ts`:

```ts
// The protocol's value is what the compiler rejects. These assertions run
// under `bun run typecheck` (tsconfig includes tests/); the single runtime
// test only keeps bun from reporting an empty file.
import { describe, expect, test } from "bun:test";
import type { DaemonConnection, Op, ResultOf } from "../src/daemon/protocol.ts";

declare const c: DaemonConnection;

async function typeChecks(): Promise<void> {
  // Zero-arg ops accept no args or an empty tuple.
  const pong: "pong" = await c.request("ping");
  const st: { url: string; title: string } = await c.request("state", []);
  // Results are typed without casts.
  const cookies: Array<{ name: string; value: string }> = await c.request("cookie-get-all", [undefined]);
  const shot: { path: string } | string = await c.request("screenshot", ["/tmp/x.png"]);
  const r: unknown = await c.request("evaluate", ["1"]);
  void [pong, st, cookies, shot, r];

  // @ts-expect-error navigate requires a url
  await c.request("navigate");
  // @ts-expect-error resize takes numbers
  await c.request("resize", ["900", 700]);
  // @ts-expect-error unknown op
  await c.request("dblclick", ["#x"]);
  // @ts-expect-error select needs two args
  await c.request("select", ["#x"]);
}

describe("daemon protocol", () => {
  test("op names are the wire names", () => {
    const ops: Op[] = ["ping", "state", "cookie-get-all"];
    expect(ops).toHaveLength(3);
    void typeChecks;
    const okType: ResultOf<"ping"> = "pong";
    expect(okType).toBe("pong");
  });
});
```

- [ ] **Step 2: Run typecheck to see it fail**

Run: `cd <worktree> && bun run typecheck`
Expected: errors that `../src/daemon/protocol.ts` cannot be found.

- [ ] **Step 3: Write `src/daemon/protocol.ts`**

```ts
// The daemon protocol, declared once. The client (client.ts), the server
// dispatcher (server.ts) and the test double (tests/helpers/fake-client.ts)
// are all typed from `DaemonOps`, so an op added here without a handler, or
// called with the wrong arguments, fails `bun run typecheck`.
//
// Wire format is unchanged from before this file existed: newline-delimited
// JSON, requests `{ id, op, args }`, responses `{ id, ok, result | error }`.

import type { Cookie, CookieParam, DeleteCookieOptions } from "../cdp/types.ts";

/** What the `state` op returns. */
export interface PageState {
  url: string;
  title: string;
}

export interface DaemonOps {
  ping:             { args: [];                                          result: "pong" };
  shutdown:         { args: [];                                          result: void };
  state:            { args: [];                                          result: PageState };
  navigate:         { args: [url: string];                               result: void };
  evaluate:         { args: [expr: string];                              result: unknown };
  click:            { args: [selector: string];                          result: void };
  type:             { args: [text: string];                              result: void };
  press:            { args: [key: string];                               result: void };
  hover:            { args: [selector: string];                          result: void };
  select:           { args: [selector: string, value: string];           result: void };
  check:            { args: [selector: string];                          result: void };
  uncheck:          { args: [selector: string];                          result: void };
  /** With a path the daemon writes the PNG and returns `{ path }`; without
   *  one it returns base64 (reserved for a future --stdout). */
  screenshot:       { args: [path?: string];                             result: { path: string } | string };
  resize:           { args: [width: number, height: number];             result: void };
  back:             { args: [];                                          result: void };
  forward:          { args: [];                                          result: void };
  reload:           { args: [];                                          result: void };
  "cookie-get-all": { args: [urls?: string[]];                           result: Cookie[] };
  "cookie-set":     { args: [param: CookieParam];                        result: { success: boolean } };
  "cookie-delete":  { args: [name: string, opts?: DeleteCookieOptions];  result: void };
  "cookie-clear":   { args: [];                                          result: void };
}

export type Op = keyof DaemonOps;
export type ArgsOf<O extends Op> = DaemonOps[O]["args"];
export type ResultOf<O extends Op> = DaemonOps[O]["result"];

/** `request("state")` and `request("state", [])` are both fine; an op with
 *  arguments must pass them. */
export type RequestParams<O extends Op> =
  ArgsOf<O> extends [] ? [op: O, args?: []] : [op: O, args: ArgsOf<O>];

/** One request on the wire. `args` is untyped here on purpose: it is what
 *  JSON.parse produced, and server.ts casts it exactly once at dispatch. */
export interface DaemonRequest {
  id: number;
  op: Op;
  args?: unknown[];
  /** Reserved for tab support. Ignored by the server today; never set by the client. */
  page?: string;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** What a command needs from a daemon: typed requests and a close. The real
 *  DaemonClient implements it; tests implement it with a fake. */
export interface DaemonConnection {
  request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>>;
  close(): void;
}
```

- [ ] **Step 4: Verify**

Run: `cd <worktree> && bun run typecheck && bun test tests/protocol.test.ts`
Expected: typecheck clean (every `@ts-expect-error` line is a real error, none unused), 1 test passes.

- [ ] **Step 5: Commit**

```bash
cd <worktree> && git add src/daemon/protocol.ts tests/protocol.test.ts && git commit -m "feat: declare the daemon protocol once as a typed op map

DaemonOps is the single source for argument tuples and results; the
client, server and test double derive from it in the next commits."
```

---

### Task 2: `daemon/server.ts` with a testable, typed handler table

**Files:**
- Create: `src/daemon/server.ts` (from today's `startDaemon` and `handle` in `src/daemon.ts`)
- Create: `src/daemon/main.ts` (today's `src/daemon-main.ts`, import path changed)
- Create: `tests/daemon-handler.test.ts`

Leave `src/daemon.ts` and `src/daemon-main.ts` in place for now; Task 3 deletes them once the client and every import have moved. Both trees compile side by side.

**Interfaces:**
- Consumes: `DaemonOps`, `Op`, `ArgsOf`, `ResultOf`, `DaemonRequest`, `DaemonResponse` from Task 1; `Browser`, `openBrowser`, `assertValidBackendEnv` from `../browser.ts`; `createSerializer`, `withTimeout` from `../serialize.ts`; `socketWriteAll`, `flushSocket`, `WritableSocket` from `../socket-write.ts`.
- Produces: `export function createHandler(browser: Browser): (req: DaemonRequest) => Promise<DaemonResponse>`; `export async function startDaemon(session: string): Promise<void>`; `export function socketPath(session: string): string` is NOT here (Task 3 puts it in `client.ts`; server imports it from there).

- [ ] **Step 1: Write the handler test**

`tests/daemon-handler.test.ts`:

```ts
// createHandler() against a fake Browser: every op reaches the right Browser
// method with the right arguments, errors come back as { ok: false }, and
// the cookie ops pick the CDP method the way the old inline switch did.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "../src/browser.ts";
import { createHandler } from "../src/daemon/server.ts";
import type { DaemonRequest } from "../src/daemon/protocol.ts";

function fakeBrowser(over: Partial<Browser> = {}): Browser & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const rec = <T>(name: string, ret: T) => async (...a: unknown[]) => { calls.push([name, a]); return ret; };
  const b: Browser & { calls: typeof calls } = {
    calls,
    url: "https://x/", title: "X",
    realUrl: rec("realUrl", "https://x/"),
    realTitle: rec("realTitle", "X"),
    navigate: rec("navigate", undefined),
    evaluate: rec("evaluate", 42),
    click: rec("click", undefined),
    type: rec("type", undefined),
    press: rec("press", undefined),
    hover: rec("hover", undefined),
    select: rec("select", undefined),
    setChecked: rec("setChecked", undefined),
    screenshot: rec("screenshot", Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")),
    resize: rec("resize", undefined),
    back: rec("back", undefined),
    forward: rec("forward", undefined),
    reload: rec("reload", undefined),
    close: rec("close", undefined),
    cdpAvailable: () => true,
    cdp: rec("cdp", { cookies: [{ name: "a", value: "1" }], success: true }),
    ...over,
  };
  return b;
}

const req = (op: DaemonRequest["op"], args?: unknown[]): DaemonRequest => ({ id: 7, op, args });

describe("createHandler", () => {
  test("ping answers pong without touching the browser", async () => {
    const b = fakeBrowser();
    expect(await createHandler(b)(req("ping"))).toEqual({ id: 7, ok: true, result: "pong" });
    expect(b.calls).toEqual([]);
  });

  test("state returns the resolved url and title", async () => {
    const b = fakeBrowser();
    expect(await createHandler(b)(req("state"))).toEqual({ id: 7, ok: true, result: { url: "https://x/", title: "X" } });
  });

  test("navigate, select and resize forward their arguments", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("navigate", ["https://y/"]));
    await h(req("select", ["#s", "blue"]));
    await h(req("resize", [900, 700]));
    expect(b.calls).toEqual([["navigate", ["https://y/"]], ["select", ["#s", "blue"]], ["resize", [900, 700]]]);
  });

  test("check and uncheck map to setChecked", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("check", ["#c"]));
    await h(req("uncheck", ["#c"]));
    expect(b.calls).toEqual([["setChecked", ["#c", true]], ["setChecked", ["#c", false]]]);
  });

  test("screenshot with a path writes the file and returns { path }", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bowser-handler-"));
    try {
      const path = join(dir, "shot.png");
      const res = await createHandler(fakeBrowser())(req("screenshot", [path]));
      expect(res).toEqual({ id: 7, ok: true, result: { path } });
      expect(new Uint8Array(await readFile(path)).slice(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cookie-get-all scopes to Network.getCookies only when urls are given", async () => {
    const b = fakeBrowser();
    const h = createHandler(b);
    await h(req("cookie-get-all", [["https://x/"]]));
    await h(req("cookie-get-all", [undefined]));
    expect(b.calls).toEqual([
      ["cdp", ["Network.getCookies", { urls: ["https://x/"] }]],
      ["cdp", ["Network.getAllCookies", undefined]],
    ]);
  });

  test("cookie-delete forwards only the options that were set", async () => {
    const b = fakeBrowser();
    await createHandler(b)(req("cookie-delete", ["sid", { domain: "x" }]));
    expect(b.calls).toEqual([["cdp", ["Network.deleteCookies", { name: "sid", domain: "x" }]]]);
  });

  test("a throwing browser method becomes { ok: false, error }", async () => {
    const b = fakeBrowser({ click: async () => { throw new Error("click: element not found"); } });
    expect(await createHandler(b)(req("click", ["#nope"]))).toEqual({ id: 7, ok: false, error: "click: element not found" });
  });

  test("an unknown op on the wire is rejected, not thrown", async () => {
    const res = await createHandler(fakeBrowser())({ id: 7, op: "dblclick" as DaemonRequest["op"], args: [] });
    expect(res).toEqual({ id: 7, ok: false, error: "unknown op: dblclick" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd <worktree> && bun test tests/daemon-handler.test.ts`
Expected: FAIL, `../src/daemon/server.ts` not found.

- [ ] **Step 3: Write `src/daemon/server.ts`**

Move the body of today's `startDaemon` verbatim except for the dispatcher. The complete file:

```ts
// Per-session daemon. A long-lived Bun process holds one Bun.WebView and
// services client commands over a Unix socket. This is what gives Bowser
// real stateful multi-step flows — a fresh browser per command would lose
// everything the page accumulated (typed text, modals, dynamic DOM).
//
// The op set lives in ./protocol.ts. `handlers` below is typed from it, so
// an op without a handler here does not compile.

import { unlink } from "node:fs/promises";
import { openBrowser, type Browser } from "../browser.ts";
import { createSerializer, withTimeout } from "../serialize.ts";
import { socketWriteAll, flushSocket, type WritableSocket } from "../socket-write.ts";
import type { Cookie } from "../cdp/types.ts";
import type { ArgsOf, DaemonRequest, DaemonResponse, Op, ResultOf } from "./protocol.ts";
import { socketPath } from "./client.ts";

/** Per-operation timeout budget. Default 30s; override with BOWSER_OP_TIMEOUT_MS
 *  (set to 0 to disable). Guards a wedged WebKit call from hanging forever. */
function opTimeoutMs(): number {
  const raw = process.env.BOWSER_OP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}

type Handlers = {
  [O in Op]: (browser: Browser, ...args: ArgsOf<O>) => Promise<ResultOf<O>>;
};

const handlers: Handlers = {
  ping: async () => "pong",
  shutdown: async (browser) => {
    // Respond first, then exit: the caller gets its { ok: true } before the
    // process goes away.
    queueMicrotask(async () => {
      try {
        await browser.close();
      } catch {}
      process.exit(0);
    });
  },
  state: async (browser) => ({ url: await browser.realUrl(), title: await browser.realTitle() }),
  navigate: (browser, url) => browser.navigate(url),
  evaluate: (browser, expr) => browser.evaluate(expr),
  click: (browser, selector) => browser.click(selector),
  type: (browser, text) => browser.type(text),
  press: (browser, key) => browser.press(key),
  hover: (browser, selector) => browser.hover(selector),
  select: (browser, selector, value) => browser.select(selector, value),
  check: (browser, selector) => browser.setChecked(selector, true),
  uncheck: (browser, selector) => browser.setChecked(selector, false),
  screenshot: async (browser, path) => {
    // When the CLI passes an absolute path, the daemon writes the PNG itself
    // so the ~140 KB base64 never crosses the socket. With no path, return
    // base64 — reserved for a future --stdout / programmatic caller.
    const b64 = await browser.screenshot();
    if (path) {
      await Bun.write(path, Buffer.from(b64, "base64"));
      return { path };
    }
    return b64;
  },
  resize: (browser, width, height) => browser.resize(width, height),
  back: (browser) => browser.back(),
  forward: (browser) => browser.forward(),
  reload: (browser) => browser.reload(),
  // --- Cookie ops (chrome backend only; require Bun.WebView.cdp()) ---
  "cookie-get-all": async (browser, urls) => {
    const scoped = urls && urls.length > 0;
    const res = (await browser.cdp(
      scoped ? "Network.getCookies" : "Network.getAllCookies",
      scoped ? { urls } : undefined,
    )) as { cookies: Cookie[] };
    return res.cookies;
  },
  "cookie-set": async (browser, param) => {
    const res = (await browser.cdp("Network.setCookie", param as unknown as Record<string, unknown>)) as { success: boolean };
    return { success: res.success };
  },
  "cookie-delete": async (browser, name, opts = {}) => {
    const params: Record<string, unknown> = { name };
    if (opts.url) params.url = opts.url;
    if (opts.domain) params.domain = opts.domain;
    if (opts.path) params.path = opts.path;
    await browser.cdp("Network.deleteCookies", params);
  },
  "cookie-clear": async (browser) => {
    await browser.cdp("Network.clearBrowserCookies");
  },
};

/** Dispatch one parsed request to its handler. Never rejects: every failure,
 *  including an op name that is not in the map, is a `{ ok: false }` reply. */
export function createHandler(browser: Browser): (req: DaemonRequest) => Promise<DaemonResponse> {
  return async (req) => {
    const fn = Object.hasOwn(handlers, req.op) ? handlers[req.op] : undefined;
    if (!fn) return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
    try {
      // The one cast at the wire boundary: args arrived as JSON, the handler
      // is typed for this op. Everything below this line is typed.
      const result = await (fn as (b: Browser, ...a: unknown[]) => Promise<unknown>)(browser, ...(req.args ?? []));
      return result === undefined ? { id: req.id, ok: true } : { id: req.id, ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { id: req.id, ok: false, error: msg };
    }
  };
}

export async function startDaemon(session: string): Promise<void> {
  const sock = socketPath(session);
  // Clean up any stale socket file.
  try {
    await unlink(sock);
  } catch {}

  const browser: Browser = await openBrowser();
  const handle = createHandler(browser);
  const serialize = createSerializer();
  const timeoutMs = opTimeoutMs();

  Bun.listen({
    unix: sock,
    socket: {
      data(socket, data) {
        // Requests are newline-delimited. Accumulate partial data on
        // socket.data and process complete lines.
        const existing = ((socket as { data?: string }).data ?? "") + data.toString();
        const lines = existing.split("\n");
        const remainder = lines.pop() ?? "";
        (socket as { data?: string }).data = remainder;
        for (const line of lines) {
          if (!line) continue;
          let req: DaemonRequest;
          try {
            req = JSON.parse(line) as DaemonRequest;
          } catch (err) {
            socketWriteAll(
              socket as unknown as WritableSocket,
              JSON.stringify({ id: -1, ok: false, error: "invalid JSON: " + String(err) }) + "\n",
            );
            continue;
          }
          // Serialize on the UNDERLYING op (not the timeout): the WebView lock is
          // held until handle(req) actually settles, so a timed-out-but-still-
          // running op can never overlap the next one. withTimeout only governs
          // how soon we answer the client.
          if (req.op === "shutdown") {
            // Shutdown must NOT queue behind a wedged op — its job is to kill a
            // possibly-stuck daemon. Dispatch it directly, bypassing the serializer.
            handle(req).then((res) => {
              socketWriteAll(socket as unknown as WritableSocket, JSON.stringify(res) + "\n");
            }).catch(() => {
              // handle() never rejects; mirrors the guard on the serialized path.
            });
          } else {
            serialize(() => {
              const underlying = handle(req);
              withTimeout(underlying, timeoutMs, req.op).then(
                (res) => {
                  socketWriteAll(socket as unknown as WritableSocket, JSON.stringify(res) + "\n");
                },
                (err) => {
                  // handle() catches its own errors; this path is for timeouts.
                  const msg = err instanceof Error ? err.message : String(err);
                  socketWriteAll(socket as unknown as WritableSocket, JSON.stringify({ id: req.id, ok: false, error: msg }) + "\n");
                },
              );
              return underlying;
            }).catch(() => {
              // handle() never rejects; guards against an unhandled rejection.
            });
          }
        }
      },
      open(socket) {
        (socket as { data?: string }).data = "";
      },
      drain(socket) {
        flushSocket(socket as unknown as WritableSocket);
      },
      error(socket, err) {
        console.error("[bowser daemon] socket error:", err.message);
        // Close the socket so its WriteQueue (`_wq` in socket-write.ts) can't
        // strand buffered chunks on a peer that will never fire `drain` again.
        socket.end();
      },
    },
  });

  // Keep the process alive. Bun.WebView doesn't hold the loop open on its own.
  const keepalive = setInterval(() => {}, 60_000);
  // Clean up if the event loop does settle.
  process.on("beforeExit", () => clearInterval(keepalive));
}
```

(`assertValidBackendEnv` is not imported here; drop it from the import line. `client.ts` takes it from `../browser.ts` directly, so server → client is the only edge between the two and there is no import cycle.)

Note on `result === undefined`: today's `handle` returns `{ id, ok: true }` without a `result` key for void ops and `{ id, ok: true, result }` otherwise; the ternary preserves that exact wire shape.

`socketPath` is imported from `./client.ts`, which does not exist until Task 3. For this task, create a **temporary** `src/daemon/client.ts` containing only:

```ts
import { join } from "node:path";
import { sessionsRoot } from "../state.ts";

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  return join(sessionsRoot(), session, "sock");
}
```

Task 3 replaces it with the full client. (Today's `src/daemon.ts` keeps its own `socketPath` until then; both compute the same path.)

`src/daemon/main.ts`:

```ts
#!/usr/bin/env bun
// Entry point for the spawned daemon process. Keeps a single Bun.WebView alive
// and services requests until told to shut down.

import { startDaemon } from "./server.ts";

const session = process.argv[2];
if (!session) {
  console.error("daemon-main: missing session name");
  process.exit(1);
}

await startDaemon(session);
```

- [ ] **Step 4: Verify**

Run: `cd <worktree> && bun run typecheck && bun test tests/daemon-handler.test.ts tests/protocol.test.ts && bun test`
Expected: typecheck clean; 9 handler tests pass; full suite green (old `src/daemon.ts` still serves the CLI).

If `tsc` reports that `handlers` is missing a key, the map in Task 1 and this table disagree: fix the table, not the map.

- [ ] **Step 5: Commit**

```bash
cd <worktree> && git add src/daemon/server.ts src/daemon/main.ts src/daemon/client.ts tests/daemon-handler.test.ts && git commit -m "feat: daemon server with a handler table typed from DaemonOps

createHandler(browser) replaces the inline switch and is unit-tested
against a fake Browser for the first time. Wire shapes are unchanged."
```

---

### Task 3: `daemon/client.ts`, cut every import over, delete the old files

**Files:**
- Replace: `src/daemon/client.ts` (full client)
- Delete: `src/daemon.ts`, `src/daemon-main.ts`
- Modify: `src/cli.ts:163` (`./daemon.ts` → `./daemon/server.ts`)
- Modify: `src/commands.ts` (imports, `DaemonConnection`, cast removal)
- Modify: `tests/daemon.test.ts:8`, `tests/e2e-search.test.ts:18` (import path)
- Modify: `tests/commands.test.ts:8`, `tests/cookie.test.ts:9`, `tests/state-storage.test.ts:10` (import `DaemonConnection` type from `../src/daemon/protocol.ts` instead of `DaemonClient`; the fakes keep their `as unknown as` casts until Task 4)
- Modify: `tests/layers.test.ts` rule 2

**Interfaces:**
- Consumes: Task 1 types; `assertValidBackendEnv` from `../browser.ts` (not from `server.ts`, to avoid a server ↔ client import cycle).
- Produces: `class DaemonClient implements DaemonConnection` with `connect()`, typed `request`, `close()`; `connectOrSpawn(session, opts?: { spawn?: boolean }): Promise<DaemonClient>`; `socketPath(session)`; `spawnDaemon` stays private.

- [ ] **Step 1: Write `src/daemon/client.ts`**

```ts
// Client side of the daemon protocol: connect to a session's Unix socket (or
// spawn the daemon first), send typed requests, match replies by id.

import { join } from "node:path";
import { flushSocket, socketWriteAll, type WritableSocket } from "../socket-write.ts";
import { sessionsRoot } from "../state.ts";
import { assertValidBackendEnv } from "../browser.ts";
import type { DaemonConnection, DaemonResponse, Op, RequestParams, ResultOf } from "./protocol.ts";

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  return join(sessionsRoot(), session, "sock");
}

export class DaemonClient implements DaemonConnection {
  private sock: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  private nextId = 1;
  private pending = new Map<number, (res: DaemonResponse) => void>();
  private buf = "";

  constructor(private readonly path: string) {}

  async connect(): Promise<void> {
    const self = this;
    this.sock = await Bun.connect({
      unix: this.path,
      socket: {
        data(_s, data) {
          self.buf += data.toString();
          let idx: number;
          while ((idx = self.buf.indexOf("\n")) !== -1) {
            const line = self.buf.slice(0, idx);
            self.buf = self.buf.slice(idx + 1);
            if (!line) continue;
            try {
              const res = JSON.parse(line) as DaemonResponse;
              const cb = self.pending.get(res.id);
              if (cb) {
                self.pending.delete(res.id);
                cb(res);
              }
            } catch {
              // swallow
            }
          }
        },
        drain(s) {
          flushSocket(s as unknown as WritableSocket);
        },
      },
    });
  }

  request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>> {
    const [op, args = []] = params;
    if (!this.sock) throw new Error("client not connected");
    const id = this.nextId++;
    const line = JSON.stringify({ id, op, args }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, (res) => {
        if (res.ok) resolve(res.result as ResultOf<O>);
        else reject(new Error(res.error ?? "daemon error"));
      });
      socketWriteAll(this.sock! as unknown as WritableSocket, line);
    });
  }

  close(): void {
    this.sock?.end();
  }
}

/** Connect to a session's daemon, or spawn one if it isn't running. */
export async function connectOrSpawn(
  session: string,
  opts: { spawn?: boolean } = {},
): Promise<DaemonClient> {
  const sock = socketPath(session);
  const client = new DaemonClient(sock);
  try {
    await client.connect();
    await client.request("ping");
    return client;
  } catch {
    if (opts.spawn === false) throw new Error(`no daemon for session '${session}'`);
    // Validate backend config in the parent before spawning: the daemon opens
    // the browser (and would throw on a bad BOWSER_BACKEND) before it ever opens
    // its socket, so that error is invisible to us and shows up only as the
    // "did not start in time" timeout below. Fail fast with the real message.
    assertValidBackendEnv();
    await spawnDaemon(session);
    // Poll until the socket is listening.
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        const c = new DaemonClient(sock);
        await c.connect();
        await c.request("ping");
        return c;
      } catch {
        await Bun.sleep(50);
      }
    }
    throw new Error(`daemon for session '${session}' did not start in time`);
  }
}

async function spawnDaemon(session: string): Promise<void> {
  const { ensureSessionDir } = await import("../state.ts");
  await ensureSessionDir(session);

  // When running as a compiled single-file binary, import.meta.url points to
  // a virtual /$bunfs/root/ path that Bun.spawn cannot execute. In that case
  // re-invoke the binary itself with a hidden --daemon flag; cli.ts intercepts
  // it before the normal command dispatcher and starts the daemon directly.
  // Use includes(), not startsWith(): Bun reports this module's import.meta.url
  // as "file:///$bunfs/root/..." (with a file:// scheme), so a startsWith check
  // misses it and silently falls through to the broken, unspawnable path.
  const isCompiled = import.meta.url.includes("/$bunfs/");
  const cmd: string[] = isCompiled
    ? [process.execPath, "--daemon", session]
    : [process.execPath, new URL("./main.ts", import.meta.url).pathname, session];

  // When BOWSER_CHROME_DEBUG is set, let the daemon's stdio through so spawn
  // failures are diagnosable.
  const debug = process.env.BOWSER_CHROME_DEBUG === "1";
  const stdio: "ignore" | "inherit" = debug ? "inherit" : "ignore";

  const proc = Bun.spawn({
    cmd,
    stdout: stdio,
    stderr: stdio,
    stdin: "ignore",
    // Pass the LIVE process.env. Without an explicit `env`, Bun.spawn inherits
    // the OS environment block captured at *this* process's startup and ignores
    // runtime mutations of process.env — so a redirected HOME (set after launch,
    // e.g. by the e2e tests' beforeAll) would NOT reach the daemon.
    env: { ...process.env },
  });
  // Don't let the spawned daemon keep THIS process alive. Bun keeps the parent's
  // event loop open until a child exits — but the daemon runs forever (keepalive
  // interval), so without unref() a daemon-spawning command (e.g. `bowser open`
  // on a fresh session) prints its result and then hangs indefinitely instead of
  // returning to the shell. `bun test` masks this (the test runner force-exits);
  // the real binary does not. unref() lets the short-lived CLI exit immediately.
  proc.unref();
}
```

(The old `void sessionDir;` dead line and the split stdout/stderr variables are gone; behavior is identical.)

- [ ] **Step 2: Cut over the imports and remove the casts**

`src/cli.ts`: `const { startDaemon } = await import("./daemon/server.ts");` and in the comment two lines above, `daemon-main.ts` → `daemon/main.ts`.

`src/commands.ts`:
- Imports: `import { connectOrSpawn, socketPath } from "./daemon/client.ts";` and `import type { DaemonConnection } from "./daemon/protocol.ts";`
- `CommandContext.connect?: (session: string, opts?: { spawn?: boolean }) => Promise<DaemonConnection>;` and `connector()` returns that type; `withClient`'s `fn: (c: DaemonConnection) => Promise<T>`; `cookieUrls(c: DaemonConnection, …)`.
- Delete every `as { url: string; title: string }` after `c.request("state")` (10 sites) and every `as Cookie[]` after `c.request("cookie-get-all", …)` (3 sites). Keep `as SnapshotResult` on `evaluate` (evaluate is `unknown` by design). If the `Cookie` type import becomes unused, remove it from the import line.
- `closeOne`: `client.request("shutdown")` unchanged.

Tests: change the five import lines listed in **Files**; in `tests/commands.test.ts`, `tests/cookie.test.ts`, `tests/state-storage.test.ts` replace `DaemonClient` with `DaemonConnection` in the type annotations and casts (Task 4 removes the casts).

`tests/layers.test.ts`: rule 2 becomes

```ts
  {
    name: "only src/daemon/server.ts calls openBrowser",
    // browser.ts is exempt because the regex also matches its own definition site.
    violates: (file, text) => file !== "src/daemon/server.ts" && file !== "src/browser.ts" && /\bopenBrowser\s*\(/.test(text),
  },
```

and rule 3's list gains `"src/daemon/protocol.ts"` (type-only imports only). Add rule 4:

```ts
  {
    name: "commands.ts talks to the daemon only through client.ts and protocol.ts",
    violates: (file, text) =>
      file === "src/commands.ts" && valueImports(text).some((s) => s.endsWith("daemon/server.ts") || s.endsWith("browser.ts")),
  },
```

Note rule 4 will FAIL today because `commands.ts` imports `bowserCacheRoot, detectChromium` from `browser.ts` (for `install`). That split is PR 3 (`backend.ts`). So write rule 4 with only the `daemon/server.ts` clause now and a comment: `// PR 3 adds browser.ts here once install's helpers move to backend.ts.`

Then delete the old files:

```bash
cd <worktree> && git rm -q src/daemon.ts src/daemon-main.ts
```

- [ ] **Step 3: Verify, including the compiled binary**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green. `grep -rn "daemon.ts\|daemon-main" src tests` prints nothing except comments that now say `daemon/main.ts`.

Run the real spawn path on both backends:

```bash
cd <worktree> && BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test tests/e2e.test.ts tests/e2e-webkit.test.ts
cd <worktree> && bun build src/cli.ts --compile --outfile dist/bowser && BOWSER_BACKEND=webkit ./dist/bowser open "data:text/html,<title>Hi</title><p>x</p>" --session pr2-smoke && BOWSER_BACKEND=webkit ./dist/bowser snapshot --session pr2-smoke && BOWSER_BACKEND=webkit ./dist/bowser close --session pr2-smoke
```
Expected: e2e green; the binary prints `opened data:text/html,... "Hi"`, a YAML snapshot, `closed session 'pr2-smoke'`, and returns to the shell promptly (no hang = `unref` intact). `pgrep -fl "daemon/main|--daemon"` prints nothing afterwards.

- [ ] **Step 4: Commit**

```bash
cd <worktree> && git add -A src tests && git commit -m "refactor: split the daemon into protocol, server, client and main

DaemonClient.request is typed from DaemonOps, so commands.ts drops its
result casts. spawnDaemon points at daemon/main.ts. The wire format and
every op name are unchanged."
```

---

### Task 4: One typed fake client for all command tests

**Files:**
- Create: `tests/helpers/fake-client.ts`
- Modify: `tests/commands.test.ts:22-108` (delete `fakeClient`, import the helper)
- Modify: `tests/cookie.test.ts:22-58` (delete `fakeCookieClient`, use the helper)
- Modify: `tests/state-storage.test.ts:20-51` (delete `fakeStateClient`, use the helper)

**Interfaces:**
- Consumes: `DaemonConnection`, `DaemonOps`, `Op`, `ArgsOf`, `ResultOf` from `src/daemon/protocol.ts`.
- Produces: `fakeClient(handlers?: FakeHandlers): DaemonConnection & { calls: Array<[string, unknown[]]> }` where `type FakeHandlers = { [O in Op]?: (...args: ArgsOf<O>) => ResultOf<O> | Promise<ResultOf<O>> }`.

- [ ] **Step 1: Write the helper**

`tests/helpers/fake-client.ts`:

```ts
// A DaemonConnection whose behavior is a partial map of typed handlers.
// Ops without a handler get the same defaults the three old hand-written
// fakes had: ping → "pong", state → the last navigated url with a "Fake …"
// title, screenshot → mirror the daemon (write the file when given a path),
// cookie-set → { success: true }, cookie-get-all → [], everything else →
// undefined. Every request is recorded in `calls` as [op, args].

import type { ArgsOf, DaemonConnection, Op, ResultOf } from "../../src/daemon/protocol.ts";

export type FakeHandlers = {
  [O in Op]?: (...args: ArgsOf<O>) => ResultOf<O> | Promise<ResultOf<O>>;
};

export type FakeClient = DaemonConnection & { calls: Array<[string, unknown[]]> };

export function fakeClient(handlers: FakeHandlers = {}): FakeClient {
  const calls: Array<[string, unknown[]]> = [];
  let currentUrl = "";
  let currentTitle = "";

  const defaults: FakeHandlers = {
    ping: () => "pong",
    state: () => ({ url: currentUrl, title: currentTitle }),
    screenshot: async (path) => {
      const b64 = "";
      if (path) {
        await Bun.write(path, Buffer.from(b64, "base64"));
        return { path };
      }
      return b64;
    },
    "cookie-get-all": () => [],
    "cookie-set": () => ({ success: true }),
  };

  return {
    calls,
    async request(...params) {
      const [op, args = []] = params as [Op, unknown[]?];
      calls.push([op, args]);
      if (op === "navigate") {
        currentUrl = args[0] as string;
        currentTitle = "Fake " + currentUrl;
      }
      const fn = (handlers[op] ?? defaults[op]) as ((...a: unknown[]) => unknown) | undefined;
      return (fn ? await fn(...args) : undefined) as never;
    },
    close() {},
  };
}
```

The `as never` on the return is the one place the fake meets the generic `request` signature; handlers themselves are fully typed, so a test that passes `state: () => ({ url: 1 })` fails `tsc`.

- [ ] **Step 2: Migrate the three test files**

In each file, delete the local fake factory and add `import { fakeClient } from "./helpers/fake-client.ts";`.

- `tests/commands.test.ts`: every `fakeClient({ … })` call keeps working as-is (same handler names). The old `screenshot?: (selector?: string) => string` handler shape becomes `screenshot: (path?: string) => …`; check any test that passes a `screenshot` handler and adapt its parameter name only.
- `tests/cookie.test.ts`: `fakeCookieClient({...})` → `fakeClient({...})`. Its default `state` was `{ url: "https://example.com/", title: "Example" }`; tests that relied on that default must now pass `state: () => ({ url: "https://example.com/", title: "Example" })` explicitly. Keep the `"cookie-delete"` handler's `(name, opts)` shape; `opts` is now typed `DeleteCookieOptions | undefined`, so a test asserting `opts ?? {}` behaviour passes `{}` where it used to rely on the fake's default.
- `tests/state-storage.test.ts`: same migration; same `state` default note.
- Remove the now-unused `import type { DaemonConnection }` lines and the `as unknown as` casts.

Expected strings in every test stay byte-identical. If a test fails after migration, the fake's default drifted from the deleted local one: fix the handler passed by that test (or the default in the helper), never the expected string.

- [ ] **Step 3: Verify**

Run: `cd <worktree> && bun run typecheck && bun test`
Expected: green, same test count as before Task 4 (the helper adds no tests).

- [ ] **Step 4: Commit**

```bash
cd <worktree> && git add tests/helpers/fake-client.ts tests/commands.test.ts tests/cookie.test.ts tests/state-storage.test.ts && git commit -m "test: one fake daemon client typed from DaemonOps

Replaces three hand-written op switches. A handler with the wrong shape
now fails typecheck instead of silently returning undefined."
```

---

### Task 5: Docs, changelog, spec note, PR

**Files:**
- Modify: `CLAUDE.md` ("Where to look first" table row for the daemon protocol; "Adding a command" step 1; the gotcha that mentions `daemon-main.ts`)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Changed`)
- Modify: `docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md` (Section 5, PR 1 bullet that says the `OP_META` key test "belongs to PR 2")

- [ ] **Step 1: CLAUDE.md**

Table row: `| Daemon protocol? | `src/daemon/protocol.ts` (the `DaemonOps` map), `src/daemon/server.ts` (`createHandler`, `startDaemon`), `src/daemon/client.ts` (`DaemonClient`, `connectOrSpawn`), `src/daemon/main.ts` (spawn entry) |`

"Adding a command" step 1: `1. Add the op to `DaemonOps` in `src/daemon/protocol.ts` and a handler to the `handlers` table in `src/daemon/server.ts` (tsc fails until both exist); back it with a `Browser` method in `src/browser.ts`.`

Gotcha "Compiled-binary daemon spawn": replace `bun daemon-main.ts` with `bun src/daemon/main.ts`, and `cli.ts intercepts` text stays.

Add one bullet under Conventions: `- **Daemon requests are typed.** `c.request("state")` returns `PageState`; do not cast results. A new op needs an entry in `DaemonOps` and a handler in `server.ts`; `tests/helpers/fake-client.ts` picks it up automatically.`

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Changed`, append:

```markdown
- **Daemon protocol is one typed map.** `src/daemon.ts` is now `src/daemon/{protocol,server,client,main}.ts`.
  `DaemonOps` declares every op's arguments and result; the client's `request`, the server's handler
  table and the tests' fake client derive from it, so a new op without a handler fails `bun run
  typecheck`. No wire, CLI or `--json` change.
```

- [ ] **Step 3: Spec note**

In Section 5's PR 1 bullet list, change the sentence `The `OP_META` key test belongs to PR 2, where `OP_META` is born.` to `The `OP_META` table and its key test belong to PR 6, which introduces urgent routing; PR 2 declares the op map only.`

- [ ] **Step 4: Full gate, push, PR**

```bash
cd <worktree> && bun run typecheck && bun test && BOWSER_E2E=1 BOWSER_BACKEND=webkit bun test && BOWSER_E2E=1 BOWSER_BACKEND=chrome BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) bun test tests/e2e.test.ts tests/e2e-todo.test.ts tests/e2e-cookie.test.ts
```
Expected: all green; `pgrep -fl "daemon/main|--daemon"` empty afterwards.

```bash
cd <worktree> && git add CLAUDE.md CHANGELOG.md docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md && git commit -m "docs: point at the split daemon and the typed op map" && git push -u origin refactor/2-typed-protocol
gh pr create --base main --title "Refactor PR 2: typed daemon protocol" --body-file - <<'EOF'
Second PR of the maintainability series (spec: docs/superpowers/specs/2026-09-05-maintainability-refactor-design.md, Section 2).

- `src/daemon.ts` → `src/daemon/{protocol,server,client,main}.ts`.
- `DaemonOps` declares every op's argument tuple and result once. `DaemonClient.request`, the server's handler table and the tests' fake client are typed from it; a new op without a handler fails `bun run typecheck`.
- `createHandler(browser)` is unit-tested against a fake `Browser` for the first time (9 cases).
- Three hand-written fake clients in tests become one typed helper.
- `commands.ts` drops every result cast. Wire format, op names, CLI output and `--json` shapes are unchanged; a client from this branch talks to a daemon from `main`.

Not in this PR: `OP_META` / urgent routing (PR 6), `Browser` absorbing cookie ops and native history (PR 3).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_013ewRhMrEweLUze4MjKXFbj
EOF
```

---

## Self-review against the spec

- **Section 2 → tasks:** `DaemonOps`, `Op`, typed `request`, typed handler table, typed fake, `page?` reserved, wire unchanged: Tasks 1–4. `urgent`/`requires` markers and `OP_META` deliberately deferred to PR 6 (Task 5 corrects the spec sentence that put the key test here).
- **Section 1 layout:** `daemon/{protocol,server,client,main}.ts` created, old files deleted (Task 3); layer rules updated (Task 3).
- **Contract:** the `result === undefined` ternary in `createHandler` keeps the exact response shape; `request` still sends `{ id, op, args }`; commands.ts strings untouched (Tasks 2–4).
- **Names consistent:** `createHandler`, `startDaemon`, `socketPath`, `connectOrSpawn`, `DaemonConnection`, `RequestParams`, `fakeClient`/`FakeHandlers` used identically across tasks.
- **Placeholder scan:** none.
