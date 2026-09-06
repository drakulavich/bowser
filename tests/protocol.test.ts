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
