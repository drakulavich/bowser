// The daemon protocol, declared once. The client (client.ts), the server
// dispatcher (server.ts) and the test double (tests/helpers/fake-client.ts)
// are all typed from `DaemonOps`, so an op added here without a handler, or
// called with the wrong arguments, fails `bun run typecheck`.
//
// Wire format is unchanged from before this file existed: newline-delimited
// JSON, requests `{ id, op, args }`, responses `{ id, ok, result | error }`.

/** A dialog the page opened. Only a prompt has a `defaultValue`. */
export interface DialogState {
  type: "alert" | "confirm" | "prompt";
  message: string;
  defaultValue?: string;
}

/** A dialog as a command reports it. No dialog stays open: each is answered
 *  the moment it opens, with the one-shot answer or else dismissed. The
 *  --json form is this minus `unanswered`. */
export interface DialogReport extends DialogState {
  state: "accepted" | "dismissed";
  /** The text an accepted prompt was answered with. */
  answer?: string;
  /** Dismissed because no one-shot answer was set; the plain output adds a
   *  hint. */
  unanswered?: true;
}

/** What the `state` op returns. */
export interface PageState {
  url: string;
  title: string;
  /** The daemon's persistent profile directory; absent when its store is
   *  ephemeral. `open --persistent` compares it with the one it wants. */
  profile?: string;
}

export interface DaemonOps {
  ping:             { args: [];                                          result: "pong";               urgent: true };
  shutdown:         { args: [];                                          result: void;                 urgent: true };
  state:            { args: [];                                          result: PageState };
  /** Set the one-shot answer for the next dialog on this page. */
  "dialog-answer":  { args: [accept: boolean, text?: string];            result: void };
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
}

export type Op = keyof DaemonOps;
export type ArgsOf<O extends Op> = DaemonOps[O]["args"];
export type ResultOf<O extends Op> = DaemonOps[O]["result"];

/** Ops that must not queue behind a wedged operation. */
export type UrgentOp = { [O in Op]: DaemonOps[O] extends { urgent: true } ? O : never }[Op];

// The runtime mirror of the `urgent: true` markers. `satisfies` makes a
// missing entry a compile error, so an op cannot be
// declared urgent in the type and stay queued at runtime.
const URGENT_OPS = { ping: true, shutdown: true } satisfies Record<UrgentOp, true>;

export const IS_URGENT: ReadonlySet<Op> = new Set<Op>(Object.keys(URGENT_OPS) as UrgentOp[]);

/** `args` may be omitted whenever the empty tuple satisfies the op: `request("state")`,
 *  `request("screenshot")`; an op with a required argument must pass it. */
export type RequestParams<O extends Op> =
  [] extends ArgsOf<O> ? [op: O, args?: ArgsOf<O>] : [op: O, args: ArgsOf<O>];

/** One request on the wire. `args` is untyped here on purpose: it is what
 *  JSON.parse produced, and server.ts casts it exactly once at dispatch. */
export interface DaemonRequest {
  id: number;
  op: Op;
  args?: unknown[];
  /** Reserved for tab support. Ignored by the server today; never set by the client. */
  page?: string;
  /** The sender prints dialog reports: the reply hands over the queued ones.
   *  Without it they stay queued for a command that prints them. */
  report?: true;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** On a queued op's reply: the dialogs the daemon answered since the last
   *  such reply. Absent when there are none. */
  dialogs?: DialogReport[];
}

/** What a command needs from a daemon: typed requests and a close. The real
 *  DaemonClient implements it; tests implement it with a fake. */
export interface DaemonConnection {
  request<O extends Op>(...params: RequestParams<O>): Promise<ResultOf<O>>;
  /** Every dialog this connection's replies reported, in order. Empty unless
   *  reportDialogs() was called. */
  dialogs(): DialogReport[];
  /** This command prints dialog reports: ask the daemon for them. */
  reportDialogs(): void;
  close(): void;
}
