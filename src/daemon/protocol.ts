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
