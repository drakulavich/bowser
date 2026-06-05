import { describe, expect, test } from "bun:test";
import { socketWriteAll, flushSocket, type WritableSocket } from "../src/socket-write.ts";

// Fake socket that accepts at most `cap` bytes per write() call (modeling a
// small kernel send buffer) and records everything it accepts.
function fakeSocket(cap: number) {
  const out: number[] = [];
  const sock: WritableSocket & { out: number[] } = {
    out,
    write(data: Uint8Array): number {
      const n = Math.min(cap, data.length);
      for (let i = 0; i < n; i++) out.push(data[i]);
      return n;
    },
  };
  return sock;
}

describe("socketWriteAll backpressure", () => {
  test("delivers a payload larger than the per-write cap, across drains", () => {
    const sock = fakeSocket(8); // 8 bytes per write, like a small send buffer
    const payload = "x".repeat(100) + "\n";
    socketWriteAll(sock, payload);
    // The first flush accepts only one cap's worth; the rest stays buffered.
    expect(sock.out.length).toBe(8);
    // Simulate repeated drain events until the buffer empties.
    let guard = 0;
    while (sock.out.length < payload.length && guard++ < 1000) flushSocket(sock);
    expect(Buffer.from(sock.out).toString("utf-8")).toBe(payload);
  });

  test("operates on bytes, never splitting a multibyte UTF-8 codepoint", () => {
    const sock = fakeSocket(3);
    const payload = "héllo—wörld"; // 2-byte é/ö, 3-byte em dash
    socketWriteAll(sock, payload);
    let guard = 0;
    while (Buffer.from(sock.out).toString("utf-8").length < payload.length && guard++ < 1000) {
      flushSocket(sock);
    }
    expect(Buffer.from(sock.out).toString("utf-8")).toBe(payload);
  });

  test("flushSocket on an empty queue is a no-op", () => {
    const sock = fakeSocket(64);
    flushSocket(sock); // queue starts empty — must not throw
    socketWriteAll(sock, "hello\n");
    let guard = 0;
    while (sock.out.length < 6 && guard++ < 1000) flushSocket(sock);
    flushSocket(sock); // queue now empty again — must not throw
    expect(Buffer.from(sock.out).toString("utf-8")).toBe("hello\n");
  });
});
