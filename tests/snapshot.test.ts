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
  test("matches golden (flat — refs without path)", () => {
    const expected =
      `- generic:\n` +
      `  - link "More info": [ref=e1] /info\n` +
      `  - button "Submit": [ref=e2]\n` +
      `  - textbox "Email": [ref=e3] "me@x"\n` +
      `  - checkbox "Agree": [ref=e4]\n`;
    expect(toYaml(fixture)).toBe(expected);
  });

  // Nesting: refs carry a `path` of landmark ancestors. toYaml renders
  // landmarks as parent nodes and reuses shared prefixes between siblings.
  const nested: SnapshotResult = {
    url: "https://shop.example/",
    title: "Shop",
    refs: [
      { id: "e1", selector: "#home",   role: "link",   name: "Home",   tag: "a", href: "/",
        path: [{ role: "navigation", name: "Primary" }] },
      { id: "e2", selector: "#about",  role: "link",   name: "About",  tag: "a", href: "/about",
        path: [{ role: "navigation", name: "Primary" }] },
      { id: "e3", selector: "#email",  role: "textbox",name: "Email",  tag: "input",
        path: [{ role: "main", name: "" }, { role: "form", name: "Sign up" }] },
      { id: "e4", selector: "#submit", role: "button", name: "Submit", tag: "button",
        path: [{ role: "main", name: "" }, { role: "form", name: "Sign up" }] },
      { id: "e5", selector: "#contact",role: "link",   name: "Contact",tag: "a", href: "/c",
        path: [{ role: "contentinfo", name: "" }] },
    ],
  };

  test("nests landmarks, reuses shared prefixes", () => {
    const expected =
      `- generic:\n` +
      `  - navigation "Primary":\n` +
      `    - link "Home": [ref=e1] /\n` +
      `    - link "About": [ref=e2] /about\n` +
      `  - main "":\n` +
      `    - form "Sign up":\n` +
      `      - textbox "Email": [ref=e3]\n` +
      `      - button "Submit": [ref=e4]\n` +
      `  - contentinfo "":\n` +
      `    - link "Contact": [ref=e5] /c\n`;
    expect(toYaml(nested)).toBe(expected);
  });

  test("depth=1 collapses to flat (no landmark parents)", () => {
    const expected =
      `- generic:\n` +
      `  - link "Home": [ref=e1] /\n` +
      `  - link "About": [ref=e2] /about\n` +
      `  - textbox "Email": [ref=e3]\n` +
      `  - button "Submit": [ref=e4]\n` +
      `  - link "Contact": [ref=e5] /c\n`;
    expect(toYaml(nested, 1)).toBe(expected);
  });

  test("depth=2 keeps only the outermost landmark", () => {
    // The form/Sign-up node is dropped under main; its leaves attach to main.
    const expected =
      `- generic:\n` +
      `  - navigation "Primary":\n` +
      `    - link "Home": [ref=e1] /\n` +
      `    - link "About": [ref=e2] /about\n` +
      `  - main "":\n` +
      `    - textbox "Email": [ref=e3]\n` +
      `    - button "Submit": [ref=e4]\n` +
      `  - contentinfo "":\n` +
      `    - link "Contact": [ref=e5] /c\n`;
    expect(toYaml(nested, 2)).toBe(expected);
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

  test("includes path when refs are nested", () => {
    const obj = JSON.parse(toJson({
      url: "u", title: "t",
      refs: [{
        id: "e1", selector: "a", role: "link", name: "Home", tag: "a", href: "/",
        path: [{ role: "navigation", name: "Primary" }],
      }],
    }));
    expect(obj.refs[0].path).toEqual([{ role: "navigation", name: "Primary" }]);
  });
});
