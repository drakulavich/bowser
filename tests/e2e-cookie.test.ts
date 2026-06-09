// End-to-end cookie tests against a real headless Chromium (chrome backend).
//
// Gated on BOWSER_E2E=1 AND BOWSER_BACKEND=chrome. Run with:
//
//   BOWSER_E2E=1 BOWSER_BACKEND=chrome \
//     BOWSER_CHROMIUM_PATH=$(find ~/.bowser/chromium -type f -name chrome-headless-shell | head -1) \
//     bun test tests/e2e-cookie.test.ts
//
// Key assertion (the spec's核心 risk):
//   An HttpOnly cookie set via cookie-set --http-only MUST appear in
//   cookie-list but MUST NOT appear in document.cookie (JS-invisible).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectChromium } from "../src/browser.ts";
import {
  cmdClose,
  cmdCookieClear,
  cmdCookieDelete,
  cmdCookieGet,
  cmdCookieList,
  cmdCookieSet,
  cmdEval,
  cmdOpen,
} from "../src/commands.ts";

const E2E = process.env.BOWSER_E2E === "1";
const IS_CHROME = process.env.BOWSER_BACKEND === "chrome";
const runOrSkip = E2E && IS_CHROME ? describe : describe.skip;

runOrSkip("e2e: cookie-* commands (chrome backend)", () => {
  let tmp: string;
  let origHome: string | undefined;
  let server: { stop: () => void } | undefined;
  let baseUrl: string;
  const session = "e2e-cookie";

  beforeAll(async () => {
    origHome = process.env.HOME;
    tmp = await mkdtemp(join(tmpdir(), "bowser-cookie-e2e-"));
    process.env.HOME = tmp;

    const path = detectChromium();
    if (!path) {
      throw new Error(
        "BOWSER_E2E=1 with BOWSER_BACKEND=chrome was set but no Chromium binary was found. " +
          "Set BOWSER_CHROMIUM_PATH or run `bowser install`.",
      );
    }

    // Serve a minimal HTML page on a real HTTP origin so cookies + document.cookie
    // behave like a proper web context (data: URLs disable cookies in Chrome).
    const s = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          `<html><head><title>Cookie E2E</title></head><body><p>cookie test</p></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    server = { stop: () => s.stop(true) };
    baseUrl = s.url.toString().replace(/\/$/, ""); // e.g. http://127.0.0.1:PORT

    // Open the local page so the daemon is running on the chrome backend.
    await cmdOpen({ session, json: false }, baseUrl + "/");
  });

  afterAll(async () => {
    try { await cmdClose({ session, json: false }); } catch {}
    server?.stop();
    if (origHome !== undefined) process.env.HOME = origHome;
    await rm(tmp, { recursive: true, force: true });
  });

  // Helper: the URL scope used for all cookie operations in this test file.
  const cookieUrl = () => baseUrl + "/";

  test("cookie-set and cookie-list roundtrip (plain cookie)", async () => {
    await cmdCookieClear({ session, json: false });
    await cmdCookieSet({ session, json: false }, "theme", "dark", { url: cookieUrl() });
    const list = await cmdCookieList({ session, json: false }, { url: cookieUrl() });
    expect(list).toContain("theme=dark");
  }, 30_000);

  test("HttpOnly: visible in cookie-list, ABSENT from document.cookie (core risk check)", async () => {
    await cmdCookieClear({ session, json: false });

    // Set a plain visible cookie and an HttpOnly one on the same origin.
    await cmdCookieSet({ session, json: false }, "visible", "yes", { url: cookieUrl() });
    await cmdCookieSet(
      { session, json: false },
      "session_id",
      "s3cr3t_token",
      { url: cookieUrl(), httpOnly: true, secure: false },
    );

    // Both cookies appear in cookie-list (CDP has full access).
    const list = await cmdCookieList({ session, json: false }, { url: cookieUrl() });
    expect(list).toContain("visible=yes");
    expect(list).toContain("session_id=s3cr3t_token");

    // Navigate to the same origin page so document.cookie scope matches.
    await cmdOpen({ session, json: false }, cookieUrl());

    // document.cookie sees the PLAIN cookie but NOT the HttpOnly one.
    const docCookie = await cmdEval({ session, json: false }, "document.cookie");
    expect(docCookie).toContain("visible=yes");
    expect(docCookie).not.toContain("session_id");
  }, 30_000);

  test("cookie-get returns value for found cookie, empty for missing", async () => {
    await cmdCookieSet({ session, json: false }, "findme", "found!", { url: cookieUrl() });

    const found = await cmdCookieGet({ session, json: false }, "findme", { url: cookieUrl() });
    expect(found).toBe("found!");

    const missing = await cmdCookieGet({ session, json: false }, "no_such_cookie_xyz", { url: cookieUrl() });
    expect(missing).toBe("");
  }, 30_000);

  test("cookie-get --json shape", async () => {
    const out = await cmdCookieGet({ session, json: true }, "theme", { url: cookieUrl() });
    const parsed = JSON.parse(out);
    // theme may have been cleared by earlier test; just check shape
    if (parsed.ok) {
      expect(parsed.cookie).toMatchObject({ name: "theme", value: "dark" });
    } else {
      // Cookie was cleared — set it and try again
      await cmdCookieSet({ session, json: false }, "theme", "dark", { url: cookieUrl() });
      const out2 = await cmdCookieGet({ session, json: true }, "theme", { url: cookieUrl() });
      const p2 = JSON.parse(out2);
      expect(p2.ok).toBe(true);
      expect(p2.cookie).toMatchObject({ name: "theme", value: "dark" });
    }
  }, 30_000);

  test("cookie-delete removes a cookie", async () => {
    await cmdCookieSet({ session, json: false }, "del_me", "bye", { url: cookieUrl() });
    let list = await cmdCookieList({ session, json: false }, { url: cookieUrl() });
    expect(list).toContain("del_me=bye");

    await cmdCookieDelete({ session, json: false }, "del_me", { url: cookieUrl() });
    list = await cmdCookieList({ session, json: false }, { url: cookieUrl() });
    expect(list).not.toContain("del_me=bye");
  }, 30_000);

  test("cookie-clear wipes all browser cookies", async () => {
    // Set cookies on two scopes.
    await cmdCookieSet({ session, json: false }, "a", "1", { url: cookieUrl() });
    await cmdCookieSet({ session, json: false }, "b", "2", { url: "https://other-e2e-scope.invalid/" });

    await cmdCookieClear({ session, json: false });

    const listMain = await cmdCookieList({ session, json: false }, { url: cookieUrl() });
    const listOther = await cmdCookieList({ session, json: false }, { url: "https://other-e2e-scope.invalid/" });
    expect(listMain).toBe("");
    expect(listOther).toBe("");
  }, 30_000);

  test("cookie-set --json returns {ok:true}", async () => {
    const out = await cmdCookieSet(
      { session, json: true },
      "jsontest", "val",
      { url: cookieUrl() },
    );
    expect(JSON.parse(out)).toEqual({ ok: true });
  }, 30_000);

  test("cookie-list --json includes httpOnly field (true for HttpOnly, false for plain)", async () => {
    await cmdCookieClear({ session, json: false });
    await cmdCookieSet({ session, json: false }, "plain", "p", { url: cookieUrl() });
    await cmdCookieSet({ session, json: false }, "ho", "h", { url: cookieUrl(), httpOnly: true });

    const out = await cmdCookieList({ session, json: true }, { url: cookieUrl() });
    const cookies = JSON.parse(out) as Array<{ name: string; httpOnly: boolean }>;
    expect(cookies.find((c) => c.name === "plain")?.httpOnly).toBe(false);
    expect(cookies.find((c) => c.name === "ho")?.httpOnly).toBe(true);
  }, 30_000);
});
