// Unit tests for backend selection. No real browser; fs tests use a tmp HOME.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasExplicitChromium, bowserCacheRoot, resolveBackend } from "../src/browser.ts";

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
});
