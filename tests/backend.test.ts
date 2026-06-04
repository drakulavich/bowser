// Unit tests for backend selection. No real browser; fs tests use a tmp HOME.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasExplicitChromium, bowserCacheRoot } from "../src/browser.ts";

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
