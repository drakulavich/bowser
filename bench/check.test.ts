import { describe, expect, test } from "bun:test";
import { isolation, judge, skillFailed, streamCounts } from "./check.ts";
import type { Task } from "./tasks.ts";

const task: Task = { id: "compare", start: "https://x/", ask: "", expect: [/Soumission/, /50\.10/] };
const ok = (result: string) => ({ type: "result", subtype: "success", result });

describe("judge", () => {
  test("passes when the last ANSWER line matches every pattern", () => {
    expect(judge(task, ok("Done.\nANSWER: Soumission, £50.10"))).toEqual({ pass: true, answer: "Soumission, £50.10" });
  });

  test("reads the last ANSWER line, not an earlier one", () => {
    expect(judge(task, ok("ANSWER: Soumission, £50.10\nWait, rechecking.\nANSWER: Tipping the Velvet, £53.74")).pass).toBe(false);
  });

  test("fails an answer that matches only some patterns", () => {
    expect(judge(task, ok("ANSWER: Soumission, £51.77"))).toEqual({
      pass: false,
      answer: "Soumission, £51.77",
      failReason: "answer does not match /50\\.10/",
    });
  });

  test("fails when there is no ANSWER line", () => {
    expect(judge(task, ok("The cheapest is Soumission at £50.10."))).toEqual({
      pass: false,
      failReason: "no ANSWER line",
    });
  });

  test("fails a run that hit max turns", () => {
    expect(judge(task, { type: "result", subtype: "error_max_turns" })).toEqual({
      pass: false,
      failReason: "error_max_turns",
    });
  });
});

describe("isolation", () => {
  const init = {
    tools: ["Bash", "Skill"],
    mcp_servers: [],
    skills: ["bowser", "simplify", "loop"],
    plugins: [{ name: "cc-plugin-telemetry", source: "cc-plugin-telemetry@builtin" }],
  };
  const userSkills = ["humanizer", "review-ab"];

  test("accepts the tool's own skill with Claude Code's built-in skills and plugins", () => {
    expect(isolation(init, "bowser", userSkills)).toBeNull();
  });

  test("fails on an MCP server", () => {
    expect(isolation({ ...init, mcp_servers: [{ name: "playwright" }] }, "bowser", userSkills)).toBe("MCP server playwright");
  });

  test("fails on one of the user's skills", () => {
    expect(isolation({ ...init, skills: [...init.skills, "humanizer"] }, "bowser", userSkills)).toBe("user skill humanizer");
  });

  test("accepts the tool's skill when the user has one by the same name", () => {
    expect(isolation({ ...init, skills: ["playwright-cli", "simplify"] }, "playwright-cli", ["playwright-cli"])).toBeNull();
  });

  test("fails on the other tool's skill", () => {
    expect(isolation({ ...init, skills: [...init.skills, "playwright-cli"] }, "bowser", userSkills)).toBe("skill playwright-cli");
  });

  test("fails on a plugin that is not built in", () => {
    const plugins = [...init.plugins, { name: "superpowers", source: "superpowers@claude-plugins-official" }];
    expect(isolation({ ...init, plugins }, "bowser", userSkills)).toBe("plugin superpowers@claude-plugins-official");
  });

  test("fails when the tool's own skill did not load", () => {
    expect(isolation({ ...init, skills: ["simplify"] }, "bowser", userSkills)).toBe("skill bowser missing");
  });

  test("fails on a tool beyond Bash and Skill", () => {
    expect(isolation({ ...init, tools: ["Bash", "Skill", "WebFetch"] }, "bowser", userSkills)).toBe("tool WebFetch");
  });
});

test("streamCounts counts Bash calls and the bytes their results returned", () => {
  const stream = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", id: "a" },
          { type: "text", text: "x" },
        ],
      },
    },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "héllo" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "b" }] } },
    {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "skill body" }] }],
      },
    },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", id: "c" }] } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "abc" }] }] },
    },
  ];
  expect(streamCounts(stream)).toEqual({ bashCalls: 2, toolOutputBytes: 9 });
});

test("skillFailed spots a Skill call that came back as an error", () => {
  const call = { type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", id: "s" }] } };
  const result = (is_error: boolean) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "s", is_error, content: "x" }] },
  });
  expect(skillFailed([call, result(true)])).toBe(true);
  expect(skillFailed([call, result(false)])).toBe(false);
});
