export type Task = { id: string; start: string; ask: string; expect: RegExp[] };

// Expected values read with curl on 2026-10-19.
export const TASKS: Task[] = [
  {
    id: "login",
    start: "https://the-internet.herokuapp.com/login",
    ask: "Log in as tomsmith with the password SuperSecretPassword! and report the flash message shown after login.",
    expect: [/logged into a secure area/i],
  },
  {
    id: "search",
    start: "https://en.wikipedia.org/",
    ask: "Search for Ada Lovelace with the site's search box, open her article and report the year she was born.",
    expect: [/\b1815\b/],
  },
  {
    id: "form",
    start: "https://httpbin.org/forms/post",
    ask: "Fill the form: customer name Ada, pizza size large, toppings bacon and onion. Submit it and report the size and toppings the server echoed back.",
    expect: [/large/i, /bacon/i, /onion/i],
  },
  {
    id: "read",
    start: "https://playwright.dev/docs/locators",
    ask: "Read this page and report which locator Playwright recommends using first.",
    expect: [/getByRole/],
  },
  {
    id: "compare",
    start: "https://books.toscrape.com/",
    ask: 'Of the books "A Light in the Attic", "Tipping the Velvet" and "Soumission", report the cheapest one and its price.',
    expect: [/Soumission/, /50\.10/],
  },
  {
    id: "paginate",
    start: "https://quotes.toscrape.com/tag/love/",
    ask: 'Count the quotes tagged "love" across all pages and report the total.',
    expect: [/\b14\b/],
  },
  {
    id: "todo",
    start: "https://demo.playwright.dev/todomvc/",
    ask: "Add three todos (milk, bread, eggs), mark the second one completed and report the items-left counter text.",
    expect: [/\b2 items? left\b/i],
  },
  {
    id: "dynamic",
    start: "https://the-internet.herokuapp.com/dynamic_loading/2",
    ask: "Start the demo and report the text that appears when loading finishes.",
    expect: [/Hello World!/],
  },
  {
    id: "table",
    start: "https://the-internet.herokuapp.com/tables",
    ask: "In the first table, report the last name of the person with the largest amount due.",
    expect: [/\bDoe\b/],
  },
  {
    id: "session",
    start: "https://quotes.toscrape.com/login",
    ask: "Log in with any username and password, then report the author of the first quote on the page you land on.",
    expect: [/Albert Einstein/],
  },
];

export function prompt(t: Task, session: string): string {
  return [
    `Use the browser skill to do this task in a real browser. Pass -s=${session} to every browser command.`,
    `Start at ${t.start}`,
    t.ask,
    "End your reply with one line: ANSWER: <value>",
  ].join("\n");
}
