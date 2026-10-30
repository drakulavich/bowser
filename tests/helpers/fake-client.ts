// A DaemonConnection whose behavior is a partial map of typed handlers.
// Ops without a handler get the same defaults the three old hand-written
// fakes had: ping → the package version, state → the last navigated url with a "Fake …"
// title, screenshot → mirror the daemon (write the file at the path),
// select → true (the option was found), resolve → the evaluate handler (both
// run a script in the page), everything else → undefined.
// Every request is recorded in `calls` as [op, args].
//
// screenshot is not a plain overridable handler: the real daemon's contract
// is "write the file at the path", regardless of where the bytes came
// from, so that write happens here unconditionally rather than only in the
// default. A test-supplied `screenshot` handler supplies the base64 bytes,
// or returns `{ dpr }` for the daemon refusing a --scale, which writes
// nothing, or `{ path, fontsLoading: true }` for a capture taken while fonts
// were still loading, which writes the 1×1 PNG. With no handler the bytes
// are a real 1×1 PNG, since the command reads the written file's size.
//
// `opts.dialogs` is what the connection's dialogs() reports, as if the
// daemon's replies had carried them — but only once the command has called
// reportDialogs(), as the real daemon hands reports only to a command that
// prints them. `reporting` says whether it did.

import pkg from "../../package.json";
import type { ArgsOf, DaemonConnection, DialogReport, Op, ResultOf } from "../../src/daemon/protocol.ts";

const ONE_PX_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export type FakeHandlers = {
  [O in Exclude<Op, "screenshot">]?: (...args: ArgsOf<O>) => ResultOf<O> | Promise<ResultOf<O>>;
} & {
  /** The PNG as base64, or the daemon's own answer. */
  screenshot?: (...args: ArgsOf<"screenshot">) => string | ResultOf<"screenshot"> | Promise<string | ResultOf<"screenshot">>;
};

export type FakeClient = DaemonConnection & { calls: Array<[string, unknown[]]>; reporting: boolean };

export function fakeClient(handlers: FakeHandlers = {}, opts: { dialogs?: DialogReport[] } = {}): FakeClient {
  const calls: Array<[string, unknown[]]> = [];
  let currentUrl = "";
  let currentTitle = "";

  const defaults: FakeHandlers = {
    ping: () => pkg.version,
    state: () => ({ url: currentUrl, title: currentTitle }),
    select: () => true,
    hover: () => true,
  };

  const c: FakeClient = {
    calls,
    reporting: false,
    reportDialogs() {
      c.reporting = true;
    },
    async request(...params) {
      const [op, args = []] = params as [Op, unknown[]?];
      calls.push([op, args]);
      if (op === "navigate") {
        currentUrl = args[0] as string;
        currentTitle = "Fake " + currentUrl;
      }
      if (op === "screenshot") {
        const [path, scale] = args as ArgsOf<"screenshot">;
        const raw = handlers.screenshot ? await handlers.screenshot(path, scale) : ONE_PX_PNG;
        if (typeof raw === "object" && "dpr" in raw) return raw as never;
        const b64 = typeof raw === "string" ? raw : ONE_PX_PNG;
        await Bun.write(path, Buffer.from(b64, "base64"));
        return (typeof raw === "object" ? { ...raw, path } : { path }) as never;
      }
      const fn = (handlers[op] ?? (op === "resolve" ? handlers.evaluate : undefined) ?? defaults[op]) as ((...a: unknown[]) => unknown) | undefined;
      return (fn ? await fn(...args) : undefined) as never;
    },
    dialogs: () => (c.reporting ? [...(opts.dialogs ?? [])] : []),
    close() {},
  };
  return c;
}
