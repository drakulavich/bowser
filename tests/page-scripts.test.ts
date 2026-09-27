// The one rule for page scripts: anything from the user is embedded via
// JSON.stringify, so a selector or key with quotes cannot break out of the
// string. These pin that for every builder that takes user input.
import { describe, expect, test } from "bun:test";
import {
  fillScript, hoverScript, runCodeScript, selectScript, setCheckedScript,
  storageDeleteScript, storageGetScript, storageListScript, storageRestoreScript, storageSetScript,
  storageScript,
} from "../src/page-scripts.ts";

const nasty = `a"b'c\\d`;
const quoted = JSON.stringify(nasty);

describe("page scripts quote their inputs", () => {
  test("selector builders embed JSON.stringify(selector)", () => {
    for (const s of [hoverScript(nasty), selectScript(nasty, "v"), setCheckedScript(nasty, true), fillScript(nasty, "v")]) {
      expect(s).toContain(`document.querySelector(${quoted})`);
    }
    expect(selectScript("#s", nasty)).toContain(`const want = ${quoted};`);
    expect(fillScript("#s", nasty)).toContain(`const text = ${quoted};`);
  });

  test("storage builders embed JSON.stringify(key) and wrap in the area's try/catch", () => {
    expect(storageGetScript("localStorage", nasty)).toContain(`localStorage.getItem(${quoted})`);
    expect(storageSetScript("sessionStorage", nasty, nasty)).toContain(`sessionStorage.setItem(${quoted}, ${quoted})`);
    expect(storageDeleteScript("localStorage", nasty)).toContain(`localStorage.removeItem(${quoted})`);
    expect(storageRestoreScript("localStorage", [{ name: nasty, value: "1" }])).toContain(`localStorage.setItem(${quoted}, "1");`);
    expect(storageScript("localStorage", "x")).toBe("(() => { try { x } catch (e) { throw new Error('localStorage: ' + (e && e.message || e)); } })()");
  });

  test("the list builder is the storage dump every list command shares", () => {
    expect(storageListScript("localStorage")).toBe(storageScript("localStorage",
      "const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o;"));
  });

  // The script runs here in Bun: none of these codes touch the page.
  const runCode = async (code: string): Promise<unknown> => (0, eval)(runCodeScript(code));

  test("run-code evaluates one expression as an expression (spec F18)", async () => {
    expect(await runCode("(() => { return 5 })()")).toEqual({ value: 5 });
    expect(await runCode("1 + 1 // a trailing comment")).toEqual({ value: 2 });
    expect(await runCode("Promise.resolve(3)")).toEqual({ value: 3 });
  });

  test("run-code runs anything else as the body of an async function", async () => {
    expect(await runCode("return 1;")).toEqual({ value: 1 });
    expect(await runCode("await new Promise(r => setTimeout(r, 5)); return 1")).toEqual({ value: 1 });
    expect(await runCode("const a = 2; a * 3")).toEqual({ value: undefined });
    // Unbalanced parens that would read as an expression inside a wrapper
    // stay a body, so the syntax error surfaces.
    await expect(runCode("1), (2")).rejects.toThrow(SyntaxError);
  });

  test("run-code answers { fn: true } for a function result, and runs nothing more", async () => {
    expect(await runCode("async page => { return await page.title() }")).toEqual({ fn: true });
    expect(await runCode("() => document.title")).toEqual({ fn: true });
    expect(await runCode("return function () {}")).toEqual({ fn: true });
  });
});
