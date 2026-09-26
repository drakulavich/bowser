// A DaemonConnection whose behavior is a partial map of typed handlers.
// Ops without a handler get the same defaults the three old hand-written
// fakes had: ping → "pong", state → the last navigated url with a "Fake …"
// title, screenshot → mirror the daemon (write the file when given a path),
// everything else → undefined. Every request is recorded in `calls` as [op, args].
//
// screenshot is not a plain overridable handler: the real daemon's contract
// is "write the file when given a path", regardless of where the bytes came
// from, so that write happens here unconditionally rather than only in the
// default. A test-supplied `screenshot` handler only supplies the base64
// bytes — used when it returns a string, treated as "" otherwise — and can
// never skip the write.
//
// `opts.dialogs` is what the connection's dialogs() reports, as if the
// daemon's replies had carried them — but only once the command has called
// reportDialogs(), as the real daemon hands reports only to a command that
// prints them. `reporting` says whether it did.

import type { ArgsOf, DaemonConnection, DialogReport, Op, ResultOf } from "../../src/daemon/protocol.ts";

export type FakeHandlers = {
  [O in Op]?: (...args: ArgsOf<O>) => ResultOf<O> | Promise<ResultOf<O>>;
};

export type FakeClient = DaemonConnection & { calls: Array<[string, unknown[]]>; reporting: boolean };

export function fakeClient(handlers: FakeHandlers = {}, opts: { dialogs?: DialogReport[] } = {}): FakeClient {
  const calls: Array<[string, unknown[]]> = [];
  let currentUrl = "";
  let currentTitle = "";

  const defaults: FakeHandlers = {
    ping: () => "pong",
    state: () => ({ url: currentUrl, title: currentTitle }),
  };

  const c: FakeClient = {
    calls,
    reporting: false,
    reportDialogs() { c.reporting = true; },
    async request(...params) {
      const [op, args = []] = params as [Op, unknown[]?];
      calls.push([op, args]);
      if (op === "navigate") {
        currentUrl = args[0] as string;
        currentTitle = "Fake " + currentUrl;
      }
      if (op === "screenshot") {
        const path = args[0] as string | undefined;
        const raw = handlers.screenshot ? await handlers.screenshot(path) : undefined;
        const b64 = typeof raw === "string" ? raw : "";
        if (path) {
          await Bun.write(path, Buffer.from(b64, "base64"));
          return { path } as never;
        }
        return b64 as never;
      }
      const fn = (handlers[op] ?? defaults[op]) as ((...a: unknown[]) => unknown) | undefined;
      return (fn ? await fn(...args) : undefined) as never;
    },
    dialogs: () => (c.reporting ? [...(opts.dialogs ?? [])] : []),
    close() {},
  };
  return c;
}
