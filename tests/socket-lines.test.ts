// #75: the daemon socket carries newline-delimited JSON as UTF-8, and a read
// can end inside a multi-byte character. Decoding each chunk on its own turned
// that character into U+FFFD, in both directions, reported as success.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/daemon/client.ts";
import { lineReader } from "../src/socket-lines.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("lineReader", () => {
  test("a character split across chunks arrives whole", () => {
    const lines: string[] = [];
    const read = lineReader((l) => lines.push(l));
    const all = bytes("é😀\n");
    // Every split point, including inside both characters.
    for (let i = 1; i < all.length; i++) {
      read(all.subarray(0, i));
      read(all.subarray(i));
    }
    expect(lines).toEqual(Array(all.length - 1).fill("é😀"));
  });

  test("several lines in one chunk, and a line over several chunks", () => {
    const lines: string[] = [];
    const read = lineReader((l) => lines.push(l));
    read(bytes("a\nb\nc"));
    read(bytes("d"));
    read(bytes("e\n"));
    expect(lines).toEqual(["a", "b", "cde"]);
  });
});

describe("DaemonClient reads a reply split inside a character", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "bowser-lines-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("the result has no U+FFFD", async () => {
    const sock = join(dir, "sock");
    // Short enough for each write to go out whole.
    const text = "é😀".repeat(10);
    const server = Bun.listen({
      unix: sock,
      socket: {
        async data(s, data) {
          const req = JSON.parse(data.toString()) as { id: number };
          const reply = bytes(JSON.stringify({ id: req.id, ok: true, result: text }) + "\n");
          // Cut inside the first emoji, then let the reader see the halves
          // as two reads.
          const cut = reply.indexOf(0xf0) + 2;
          s.write(reply.subarray(0, cut));
          await Bun.sleep(30);
          s.write(reply.subarray(cut));
        },
      },
    });
    const client = new DaemonClient(sock, "lines");
    try {
      await client.connect();
      expect(await client.request("evaluate", ["x"])).toBe(text);
    } finally {
      client.close();
      server.stop(true);
    }
  });
});
