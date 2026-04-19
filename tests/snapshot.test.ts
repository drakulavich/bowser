import { describe, expect, test } from "bun:test";
import { SNAPSHOT_SCRIPT, toYaml } from "../src/snapshot.ts";

describe("toYaml", () => {
  test("renders empty snapshot", () => {
    const yaml = toYaml({ url: "https://x", title: "X", refs: [] });
    expect(yaml).toContain('url: "https://x"');
    expect(yaml).toContain('title: "X"');
    expect(yaml).toContain("refs:");
  });

  test("renders refs one per line", () => {
    const yaml = toYaml({
      url: "https://x",
      title: "X",
      refs: [
        { id: "@e1", selector: "sel1", role: "button", name: "Submit", tag: "button" },
        { id: "@e2", selector: "sel2", role: "textbox", name: "Email", tag: "input" },
      ],
    });
    expect(yaml).toContain('{ id: @e1, role: button, name: "Submit" }');
    expect(yaml).toContain('{ id: @e2, role: textbox, name: "Email" }');
  });

  test("escapes quotes in names", () => {
    const yaml = toYaml({
      url: "https://x",
      title: 'Hello "world"',
      refs: [],
    });
    expect(yaml).toContain('title: "Hello \\"world\\""');
  });
});

describe("SNAPSHOT_SCRIPT", () => {
  test("is a self-contained IIFE expression", () => {
    // Must start with ( and end with )() so evaluate() can wrap it in `await (...)`.
    expect(SNAPSHOT_SCRIPT.trim().startsWith("(")).toBe(true);
    expect(SNAPSHOT_SCRIPT.trim().endsWith(")()")).toBe(true);
  });

  test("does not reference any out-of-scope identifiers", () => {
    // Sanity check: no Node/Bun-only globals leaked into the page script.
    expect(SNAPSHOT_SCRIPT).not.toContain("require(");
    expect(SNAPSHOT_SCRIPT).not.toContain("process.");
    expect(SNAPSHOT_SCRIPT).not.toContain("Bun.");
  });
});
