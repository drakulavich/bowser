import { describe, expect, test } from "bun:test";
import { toYaml, toJson, type SnapshotResult } from "../src/snapshot.ts";

const fixture: SnapshotResult = {
  url: "https://example.com/",
  title: "Example",
  refs: [
    { id: "e1", selector: "html > body > a",        role: "link",    name: "More info", tag: "a",        href: "/info" },
    { id: "e2", selector: "html > body > button",   role: "button",  name: "Submit",    tag: "button" },
    { id: "e3", selector: "html > body > input",    role: "textbox", name: "Email",     tag: "input",    value: "me@x" },
    { id: "e4", selector: "html > body > input[2]", role: "checkbox",name: "Agree",     tag: "input" },
  ],
};

describe("toYaml (aria-tree)", () => {
  test("matches golden", () => {
    const expected =
      `- generic:\n` +
      `  - link "More info": [ref=e1] /info\n` +
      `  - button "Submit": [ref=e2]\n` +
      `  - textbox "Email": [ref=e3] "me@x"\n` +
      `  - checkbox "Agree": [ref=e4]\n`;
    expect(toYaml(fixture)).toBe(expected);
  });
});

describe("toJson", () => {
  test("includes selector and optional fields", () => {
    const obj = JSON.parse(toJson(fixture));
    expect(obj.url).toBe("https://example.com/");
    expect(obj.refs[0]).toEqual({
      ref: "e1",
      role: "link",
      name: "More info",
      selector: "html > body > a",
      href: "/info",
    });
    expect(obj.refs[2].value).toBe("me@x");
  });
});
