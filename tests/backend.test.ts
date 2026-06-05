// Unit tests for backend selection. No real browser; fs tests use a tmp HOME.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasExplicitChromium, bowserCacheRoot, resolveBackend, toBunBackend, assertValidBackendEnv, isLikelyPng } from "../src/browser.ts";

describe("hasExplicitChromium", () => {
  let tmp: string;
  let origHome: string | undefined;
  let origPath: string | undefined;

  beforeEach(async () => {
    tmp = join(tmpdir(), `bowser-backend-${Date.now()}-${Math.random()}`);
    await mkdir(tmp, { recursive: true });
    origHome = process.env.HOME;
    origPath = process.env.BOWSER_CHROMIUM_PATH;
    process.env.HOME = tmp;
    delete process.env.BOWSER_CHROMIUM_PATH;
  });

  afterEach(async () => {
    if (origHome !== undefined) process.env.HOME = origHome;
    if (origPath !== undefined) process.env.BOWSER_CHROMIUM_PATH = origPath;
    else delete process.env.BOWSER_CHROMIUM_PATH;
    await rm(tmp, { recursive: true, force: true });
  });

  test("false when no cache and no env", () => {
    expect(hasExplicitChromium()).toBe(false);
  });

  test("true when BOWSER_CHROMIUM_PATH points at an existing file", () => {
    process.env.BOWSER_CHROMIUM_PATH = "/bin/sh";
    expect(hasExplicitChromium()).toBe(true);
  });

  test("false when BOWSER_CHROMIUM_PATH points at a missing file", () => {
    process.env.BOWSER_CHROMIUM_PATH = join(tmp, "nope");
    expect(hasExplicitChromium()).toBe(false);
  });

  test("true when the bowser cache holds a binary", async () => {
    const dir = join(bowserCacheRoot(), "chromium-1140", "chrome-headless-shell-mac-arm64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "chrome-headless-shell"), "#!/bin/sh\n");
    expect(hasExplicitChromium()).toBe(true);
  });
});

describe("resolveBackend", () => {
  const noChromium = () => false;
  const yesChromium = () => true;
  const noDetect = () => undefined;
  const detectPath = () => "/path/to/chrome";

  test("macOS, no explicit chromium -> webkit", () => {
    expect(
      resolveBackend({ platform: "darwin", env: {}, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "webkit" });
  });

  test("macOS, explicit chromium -> chrome with detected path", () => {
    expect(
      resolveBackend({ platform: "darwin", env: {}, hasExplicitChromium: yesChromium, detectChromium: detectPath }),
    ).toEqual({ kind: "chrome", path: "/path/to/chrome" });
  });

  test("linux -> chrome regardless of explicit chromium", () => {
    expect(
      resolveBackend({ platform: "linux", env: {}, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "chrome" });
  });

  test("BOWSER_BACKEND=webkit wins over explicit chromium on macOS", () => {
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_BACKEND: "webkit" }, hasExplicitChromium: yesChromium, detectChromium: detectPath }),
    ).toEqual({ kind: "webkit" });
  });

  test("BOWSER_BACKEND=chrome wins over webkit default on macOS", () => {
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_BACKEND: "chrome" }, hasExplicitChromium: noChromium, detectChromium: detectPath }),
    ).toEqual({ kind: "chrome", path: "/path/to/chrome" });
  });

  test("BOWSER_BACKEND=webkit on non-macOS throws", () => {
    expect(() =>
      resolveBackend({ platform: "linux", env: { BOWSER_BACKEND: "webkit" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toThrow("only supported on macOS");
  });

  test("invalid BOWSER_BACKEND throws", () => {
    expect(() =>
      resolveBackend({ platform: "darwin", env: { BOWSER_BACKEND: "firefox" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toThrow("invalid BOWSER_BACKEND");
  });

  test("chrome carries argv + debug from env", () => {
    expect(
      resolveBackend({ platform: "linux", env: { BOWSER_CHROME_ARGS: "--no-sandbox --foo", BOWSER_CHROME_DEBUG: "1" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "chrome", argv: ["--no-sandbox", "--foo"], debug: true });
  });

  test("webkit ignores chrome-only env args (no flip to chrome)", () => {
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_CHROME_ARGS: "--no-sandbox" }, hasExplicitChromium: noChromium, detectChromium: noDetect }),
    ).toEqual({ kind: "webkit" });
  });

  test("injected env BOWSER_CHROMIUM_PATH drives the switch without injecting detectors", () => {
    // darwin + an existing explicit chromium path supplied ONLY via deps.env
    // (no hasExplicitChromium/detectChromium injected) must resolve to chrome.
    // /bin/sh is a real file on macOS/Linux, so the default detectors see it.
    expect(
      resolveBackend({ platform: "darwin", env: { BOWSER_CHROMIUM_PATH: "/bin/sh" } }),
    ).toEqual({ kind: "chrome", path: "/bin/sh" });
  });
});

describe("toBunBackend", () => {
  test("webkit -> 'webkit' string", () => {
    expect(toBunBackend({ kind: "webkit" })).toBe("webkit");
  });

  test("bare chrome -> 'chrome' string", () => {
    expect(toBunBackend({ kind: "chrome" })).toBe("chrome");
  });

  test("chrome with path -> object form", () => {
    expect(toBunBackend({ kind: "chrome", path: "/p" })).toEqual({ type: "chrome", path: "/p" });
  });

  test("chrome with argv -> object form", () => {
    expect(toBunBackend({ kind: "chrome", argv: ["--no-sandbox"] })).toEqual({ type: "chrome", argv: ["--no-sandbox"] });
  });

  test("chrome with debug -> inherits stdio", () => {
    expect(toBunBackend({ kind: "chrome", debug: true })).toEqual({ type: "chrome", stderr: "inherit", stdout: "inherit" });
  });
});

describe("assertValidBackendEnv", () => {
  test("no-op when BOWSER_BACKEND is unset", () => {
    expect(() => assertValidBackendEnv({}, "darwin")).not.toThrow();
  });

  test("no-op when BOWSER_BACKEND is empty (treated as unset)", () => {
    expect(() => assertValidBackendEnv({ BOWSER_BACKEND: "" }, "linux")).not.toThrow();
  });

  test("no-op for webkit on macOS", () => {
    expect(() => assertValidBackendEnv({ BOWSER_BACKEND: "webkit" }, "darwin")).not.toThrow();
  });

  test("no-op for chrome on any platform", () => {
    expect(() => assertValidBackendEnv({ BOWSER_BACKEND: "chrome" }, "linux")).not.toThrow();
  });

  test("throws for an invalid value", () => {
    expect(() => assertValidBackendEnv({ BOWSER_BACKEND: "firefox" }, "darwin")).toThrow("invalid BOWSER_BACKEND");
  });

  test("throws for webkit off-macOS", () => {
    expect(() => assertValidBackendEnv({ BOWSER_BACKEND: "webkit" }, "linux")).toThrow("only supported on macOS");
  });
});

describe("isLikelyPng", () => {
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test("accepts a buffer with the PNG signature and plausible length", () => {
    const buf = new Uint8Array([...PNG_SIG, ...new Array(40).fill(0)]);
    expect(isLikelyPng(buf)).toBe(true);
  });

  test("rejects a 32-byte buffer even with correct signature (one below the 33-byte floor)", () => {
    const buf = new Uint8Array([...PNG_SIG, ...new Array(24).fill(0)]); // 8 + 24 = 32
    expect(isLikelyPng(buf)).toBe(false);
  });

  test("rejects a 7-byte stub (the dogfooding bug)", () => {
    expect(isLikelyPng(new Uint8Array(7))).toBe(false);
  });

  test("rejects an empty buffer", () => {
    expect(isLikelyPng(new Uint8Array(0))).toBe(false);
  });

  test("rejects correct length but wrong magic bytes", () => {
    expect(isLikelyPng(new Uint8Array(64))).toBe(false);
  });
});
