#!/usr/bin/env bun
// Usage: bun bench/run.ts [--task id,..] [--tool bowser|playwright-cli] [--reps 3] [--dry-run]
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isolation, judge, skillFailed, streamCounts, TOOLS, type Tool } from "./check.ts";
import { prompt, TASKS, type Task } from "./tasks.ts";

const MODEL = "claude-sonnet-5-5";
const MAX_TURNS = 40;
const RUN_TIMEOUT_MS = 5 * 60_000;
const KILL_GRACE_MS = 10_000;
const ROOT = resolve(import.meta.dir, "..");

const { values: args } = parseArgs({
  options: {
    task: { type: "string" },
    tool: { type: "string" },
    reps: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
  },
});

const tasks = args.task ? TASKS.filter((t) => args.task?.split(",").includes(t.id)) : TASKS;
const tools = args.tool ? TOOLS.filter((t) => t === args.tool) : [...TOOLS];
const reps = Number(args.reps);
if (!tasks.length || !tools.length || !(reps > 0)) throw new Error("nothing to run: check --task, --tool and --reps");

type Run = { task: Task; tool: Tool; rep: number };
const plan = (tool: Tool): Run[] =>
  tasks.flatMap((task) => Array.from({ length: reps }, (_, i) => ({ task, tool, rep: i + 1 })));

if (args["dry-run"]) {
  for (const tool of tools) for (const r of plan(tool)) console.log(`${r.tool}\t${r.task.id}\t${r.rep}`);
  console.log(
    `${tools.length * tasks.length * reps} planned runs: ${tasks.length} tasks × ${tools.length} tools × ${reps} reps`,
  );
  process.exit(0);
}

async function sh(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function skillDir(tool: Tool): Promise<string> {
  if (tool === "bowser") return join(ROOT, "skills/bowser");
  const line = (await sh(["playwright-cli", "--help"], ROOT)).split("\n").find((l) => l.startsWith("Agent skill: "));
  if (!line) throw new Error("playwright-cli --help names no agent skill");
  return dirname(resolve(ROOT, line.slice("Agent skill: ".length)));
}

async function toolVersion(tool: Tool): Promise<string> {
  if (tool === "playwright-cli") return sh(["playwright-cli", "--version"]);
  const { version } = await Bun.file(join(ROOT, "package.json")).json();
  return `${version}+${await sh(["git", "rev-parse", "--short", "HEAD"], ROOT)}`;
}

const close = (tool: Tool, session: string): string[] =>
  tool === "bowser" ? ["bowser", "close", session] : ["playwright-cli", `-s=${session}`, "close"];
const list: Record<Tool, string[]> = { bowser: ["bowser", "list"], "playwright-cli": ["playwright-cli", "list"] };

const userSkills = [join(homedir(), ".claude/skills"), join(homedir(), ".agents/skills")].flatMap((d) => {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
});

const day = new Date().toLocaleDateString("sv");
const resultsFile = join(ROOT, "bench/results", `${day}.jsonl`);
const streamsDir = join(ROOT, ".bench/streams", day);
mkdirSync(dirname(resultsFile), { recursive: true });
mkdirSync(streamsDir, { recursive: true });

async function runOne({ task, tool, rep }: Run, skill: string, version: string): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), `bench-${tool}-`));
  cpSync(skill, join(cwd, ".claude/skills", tool), { recursive: true });
  const session = `bench-${task.id}-${rep}`;
  const started = Date.now();
  const p = Bun.spawn(
    [
      "claude",
      "-p",
      prompt(task, session),
      "--model",
      MODEL,
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "project",
      "--strict-mcp-config",
      "--tools",
      "Bash,Skill",
      "--allowedTools",
      `Bash(${tool}:*)`,
      "Skill",
      "--max-turns",
      String(MAX_TURNS),
      "--no-session-persistence",
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGTERM");
    setTimeout(() => p.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }, RUN_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  const reader = p.stdout.getReader();
  const reading = (async () => {
    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
  })();
  await p.exited;
  clearTimeout(timer);
  // A child that outlives claude can hold the pipe open: stop reading after a grace period.
  await Promise.race([reading, Bun.sleep(KILL_GRACE_MS)]);
  await reader.cancel().catch(() => {});
  const raw = Buffer.concat(chunks).toString();
  await sh(close(tool, session), cwd);
  rmSync(cwd, { recursive: true, force: true });
  await Bun.write(join(streamsDir, `${tool}-${task.id}-${rep}.jsonl`), raw);

  const stream = raw.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
  const init = stream.find((m) => m.type === "system" && m.subtype === "init");
  const result = stream.find((m) => m.type === "result");
  const leak = !init
    ? "no init message"
    : skillFailed(stream)
      ? "skill failed to load"
      : isolation(init, tool, userSkills);
  const verdict = timedOut
    ? { pass: false, failReason: "timeout" }
    : leak
      ? { pass: false, failReason: `isolation: ${leak}` }
      : result
        ? judge(task, result)
        : { pass: false, failReason: "no result message" };
  const u = result?.usage ?? {};
  const row = {
    task: task.id,
    tool,
    rep,
    ts: new Date(started).toISOString(),
    toolVersion: version,
    model: init?.model ?? null,
    claudeVersion: init?.claude_code_version ?? null,
    answer: null,
    failReason: null,
    ...verdict,
    inputTokens: u.input_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheCreationTokens: u.cache_creation_input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    costUsd: result?.total_cost_usd ?? null,
    durationMs: result?.duration_ms ?? Date.now() - started,
    numTurns: result?.num_turns ?? null,
    ...streamCounts(stream),
  };
  appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
  console.log(
    `${tool}\t${task.id}\t${rep}\t${row.pass ? "pass" : `FAIL ${row.failReason}`}\t${Math.round(row.durationMs / 1000)} s`,
  );
}

// One run at a time per tool, the tools side by side: at most two browsers open.
await Promise.all(
  tools.map(async (tool) => {
    const [skill, version] = [await skillDir(tool), await toolVersion(tool)];
    const open = await sh(list[tool]);
    if (open && open !== "(no browsers)")
      throw new Error(`${tool} has sessions open; close them before the benchmark:\n${open}`);
    for (const r of plan(tool)) await runOne(r, skill, version);
  }),
);
for (const tool of tools) {
  const open = await sh(list[tool]);
  if (open && open !== "(no browsers)")
    console.log(`${tool} still has sessions open, not closed by the runner:\n${open}`);
}
console.log(`results: ${resultsFile}`);
