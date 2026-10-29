import type { Task } from "./tasks.ts";

export const TOOLS = ["bowser", "playwright-cli"] as const;
export type Tool = (typeof TOOLS)[number];

type Result = { type: string; subtype: string; result?: string };
export type Verdict = { pass: boolean; answer?: string; failReason?: string };

export function judge(task: Task, r: Result): Verdict {
  if (r.subtype !== "success") return { pass: false, failReason: r.subtype };
  const answer = [...(r.result ?? "").matchAll(/^ANSWER:\s*(.+)$/gm)].at(-1)?.[1]?.trim();
  if (!answer) return { pass: false, failReason: "no ANSWER line" };
  const miss = task.expect.find((re) => !re.test(answer));
  return miss ? { pass: false, answer, failReason: `answer does not match ${miss}` } : { pass: true, answer };
}

type Init = {
  tools: string[];
  mcp_servers: { name: string }[];
  skills: string[];
  plugins: { source: string }[];
};

/** Why the run saw more than Bash, Skill, its tool's skill and Claude Code's built-ins, or null. */
export function isolation(init: Init, tool: Tool, userSkills: string[]): string | null {
  const extraTool = init.tools.find((t) => t !== "Bash" && t !== "Skill");
  if (extraTool) return `tool ${extraTool}`;
  if (init.mcp_servers[0]) return `MCP server ${init.mcp_servers[0].name}`;
  const plugin = init.plugins.find((p) => !p.source.endsWith("@builtin"));
  if (plugin) return `plugin ${plugin.source}`;
  if (!init.skills.includes(tool)) return `skill ${tool} missing`;
  const other = TOOLS.find((t) => t !== tool && init.skills.includes(t));
  if (other) return `skill ${other}`;
  const user = init.skills.find((s) => userSkills.includes(s) && !TOOLS.includes(s as Tool));
  return user ? `user skill ${user}` : null;
}

type Block = {
  type: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | { text?: string }[];
};
type Message = { type: string; message?: { content?: Block[] | string } };

const blocks = (m: Message): Block[] => (Array.isArray(m.message?.content) ? m.message.content : []);

/** True when a Skill call failed: the run then measured the tool without its skill. */
export function skillFailed(stream: Message[]): boolean {
  const calls = new Set(
    stream.flatMap((m) =>
      blocks(m)
        .filter((b) => b.type === "tool_use" && b.name === "Skill")
        .map((b) => b.id),
    ),
  );
  return stream.some((m) => blocks(m).some((b) => b.type === "tool_result" && b.is_error && calls.has(b.tool_use_id)));
}

export function streamCounts(stream: Message[]): { bashCalls: number; toolOutputBytes: number } {
  const bash = new Set<string>();
  let toolOutputBytes = 0;
  for (const m of stream) {
    for (const b of blocks(m)) {
      if (m.type === "assistant" && b.type === "tool_use" && b.name === "Bash" && b.id) bash.add(b.id);
      if (m.type === "user" && b.type === "tool_result" && b.tool_use_id && bash.has(b.tool_use_id)) {
        const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("");
        toolOutputBytes += Buffer.byteLength(text);
      }
    }
  }
  return { bashCalls: bash.size, toolOutputBytes };
}
