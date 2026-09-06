// The one rule for page scripts: anything from the user is embedded via
// JSON.stringify, so a selector or key with quotes cannot break out of the
// string. These pin that for every builder that takes user input.
import { describe, expect, test } from "bun:test";
import {
  clearForFillScript, hoverScript, runCodeScript, selectScript, setCheckedScript,
  storageDeleteScript, storageGetScript, storageRestoreScript, storageSetScript, storageScript,
} from "../src/page-scripts.ts";

const nasty = `a"b'c\\d`;
const quoted = JSON.stringify(nasty);

describe("page scripts quote their inputs", () => {
  test("selector builders embed JSON.stringify(selector)", () => {
    for (const s of [hoverScript(nasty), selectScript(nasty, "v"), setCheckedScript(nasty, true), clearForFillScript(nasty)]) {
      expect(s).toContain(`document.querySelector(${quoted})`);
    }
    expect(selectScript("#s", nasty)).toContain(`el.value = ${quoted};`);
  });

  test("storage builders embed JSON.stringify(key) and wrap in the area's try/catch", () => {
    expect(storageGetScript("localStorage", nasty)).toContain(`localStorage.getItem(${quoted})`);
    expect(storageSetScript("sessionStorage", nasty, nasty)).toContain(`sessionStorage.setItem(${quoted}, ${quoted})`);
    expect(storageDeleteScript("localStorage", nasty)).toContain(`localStorage.removeItem(${quoted})`);
    expect(storageRestoreScript("localStorage", [{ name: nasty, value: "1" }])).toContain(`localStorage.setItem(${quoted}, "1");`);
    expect(storageScript("localStorage", "x")).toBe("(() => { try { x } catch (e) { throw new Error('localStorage: ' + (e && e.message || e)); } })()");
  });

  test("run-code wraps the body in an IIFE", () => {
    expect(runCodeScript("return 1;")).toBe("(() => { return 1; })()");
  });
});
