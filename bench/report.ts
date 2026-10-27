#!/usr/bin/env bun
// Usage: bun bench/report.ts bench/results/<date>.jsonl [out.md]
import { resolve } from "node:path";
import { TOOLS } from "./check.ts";
import { TASKS } from "./tasks.ts";

type Row = {
  task: string;
  tool: string;
  rep: number;
  ts: string;
  toolVersion: string;
  model: string;
  claudeVersion: string;
  pass: boolean;
  failReason?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  bashCalls: number;
  toolOutputBytes: number;
};

const [input, out = resolve(import.meta.dir, "../docs/benchmark.md")] = process.argv.slice(2);
if (!input) throw new Error("usage: bun bench/report.ts <results.jsonl> [out.md]");
const rows: Row[] = (await Bun.file(input).text())
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const tokens = (r: Row) => r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? Number.NaN : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const k = (n: number) => (Number.isNaN(n) ? "—" : `${(n / 1000).toFixed(1)}k`);
const sec = (ms: number) => (Number.isNaN(ms) ? "—" : `${Math.round(ms / 1000)} s`);
const usd = (n: number) => (Number.isNaN(n) ? "—" : `$${n.toFixed(3)}`);

const tools = TOOLS.filter((t) => rows.some((r) => r.tool === t));
const versionOf = (tool: string) =>
  [...new Set(rows.filter((r) => r.tool === tool).map((r) => r.toolVersion))].join(", ");
const one = (f: (r: Row) => string) => [...new Set(rows.map(f))].join(", ");

type Cell = { pass: number; runs: number; tokens: number; bytes: number; ms: number; cost: number };
const cell = (task: string, tool: string): Cell => {
  const all = rows.filter((r) => r.task === task && r.tool === tool);
  const ok = all.filter((r) => r.pass);
  return {
    pass: ok.length,
    runs: all.length,
    tokens: median(ok.map(tokens)),
    bytes: median(ok.map((r) => r.toolOutputBytes)),
    ms: median(ok.map((r) => r.durationMs)),
    cost: median(ok.map((r) => r.costUsd)),
  };
};

const lines = [
  "# Agent benchmark: bowser and playwright-cli",
  "",
  `Measured ${one((r) => new Date(r.ts).toLocaleDateString("sv"))} with ${one((r) => r.model)} in Claude Code ${one((r) => r.claudeVersion)}:`,
  ...tools.map((t) => `- ${t} ${versionOf(t)}`),
  "",
  "Each task ran in a fresh `claude -p` with only that tool's own skill installed and Bash allowed only for the tool.",
  "On macOS bowser drives WebKit and playwright-cli drives Chromium. Medians come from passing runs only.",
  "Tokens are everything the agent processed: input, cache reads and writes, and output. Tool output is what the",
  "tool's commands printed back to the agent. How to rerun: `bench/README.md`.",
  "",
  `| Task | ${tools.map((t) => `${t} pass | tokens | tool output | time | cost`).join(" | ")} |`,
  `|---|${tools.map(() => "---|---:|---:|---:|---:").join("|")}|`,
];
const totals = Object.fromEntries(tools.map((t) => [t, { pass: 0, runs: 0, tokens: 0, bytes: 0, ms: 0, cost: 0 }]));
for (const task of TASKS.map((t) => t.id).filter((id) => rows.some((r) => r.task === id))) {
  const cells = tools.map((t) => {
    const c = cell(task, t);
    const sum = totals[t];
    sum.pass += c.pass;
    sum.runs += c.runs;
    for (const f of ["tokens", "bytes", "ms", "cost"] as const) if (!Number.isNaN(c[f])) sum[f] += c[f];
    const mark = c.pass < c.runs ? " ⚠" : "";
    return `${c.pass}/${c.runs}${mark} | ${k(c.tokens)} | ${k(c.bytes)} B | ${sec(c.ms)} | ${usd(c.cost)}`;
  });
  lines.push(`| ${task} | ${cells.join(" | ")} |`);
}
lines.push(
  `| **sum of medians** | ${tools
    .map((t) => {
      const s = totals[t];
      return `${s.pass}/${s.runs} | ${k(s.tokens)} | ${k(s.bytes)} B | ${sec(s.ms)} | ${usd(s.cost)}`;
    })
    .join(" | ")} |`,
  "",
  "⚠ marks a task that did not pass every run; its medians cover the passing runs.",
  "",
);
const failed = rows.filter((r) => !r.pass);
if (failed.length) {
  lines.push("Failed runs:", "", ...failed.map((r) => `- ${r.tool} ${r.task} #${r.rep}: ${r.failReason}`), "");
}
await Bun.write(out, lines.join("\n"));
console.log(`wrote ${out}`);
