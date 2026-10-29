#!/usr/bin/env bun
// Usage: bun scripts/upload-flakiness.ts <junit.xml> <category> <org/project>
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONVERTER = "@flakiness/junit-xml@1.4.0";
const UPLOADER = "flakiness@0.311.0";

type Report = {
  environments?: { name?: string; systemData?: { osName?: string; osVersion?: string }; metadata?: Record<string, unknown> }[];
};

export function normaliseReport(report: Report): void {
  const environments = report.environments ?? [];
  if (environments.length === 0) throw new Error("the report has no environments");
  for (const env of environments) {
    const system = env.systemData;
    const full = system?.osVersion ?? "";
    const match = /^(\d+\.\d+)(\.\d+)?$/.exec(full);
    if (!system || system.osName?.toLowerCase() !== "macos" || !match?.[1]) {
      throw new Error(`environment ${JSON.stringify(env.name)} reports ${JSON.stringify(system)}, expected macos with a major.minor version`);
    }
    system.osVersion = match[1];
    env.metadata = { ...env.metadata, osVersionFull: full };
  }
}

async function run(command: string[]): Promise<void> {
  const code = await Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }).exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

if (import.meta.main) {
  const [junit, category, project] = process.argv.slice(2);
  if (!junit || !category || !project) throw new Error("usage: upload-flakiness.ts <junit.xml> <category> <org/project>");
  const outDir = mkdtempSync(join(tmpdir(), "flakiness-"));
  try {
    await run(["bunx", CONVERTER, junit, "--category", category, "--flakiness-project", project, "--disable-upload", "--output-dir", outDir]);
    const reportPath = join(outDir, "report.json");
    if (!existsSync(reportPath)) throw new Error(`the converter wrote no ${reportPath}`);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
    normaliseReport(report);
    writeFileSync(reportPath, JSON.stringify(report));
    await run(["bunx", UPLOADER, "upload", reportPath, "--project", project]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
