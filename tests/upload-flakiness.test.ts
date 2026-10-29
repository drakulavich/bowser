import { describe, expect, test } from "bun:test";
import { normaliseReport } from "../scripts/upload-flakiness.ts";

// The shape @flakiness/junit-xml 1.4.0 writes to report.json on a macOS runner.
function macos(osVersion: string) {
  return { name: "bun", systemData: { osArch: "arm64", osName: "macos", osVersion }, metadata: {} as Record<string, unknown> };
}

describe("normaliseReport", () => {
  test("cuts the macOS version to major.minor and keeps the full one in metadata", () => {
    const report = { environments: [macos("26.6.2")] };
    normaliseReport(report);
    expect(report.environments[0]).toEqual({
      name: "bun",
      systemData: { osArch: "arm64", osName: "macos", osVersion: "26.6" },
      metadata: { osVersionFull: "26.6.2" },
    });
  });

  test("leaves a major.minor version as it is", () => {
    const report = { environments: [macos("26.6")] };
    normaliseReport(report);
    expect(report.environments[0]?.systemData.osVersion).toBe("26.6");
  });

  test("refuses a report with no environments", () => {
    expect(() => normaliseReport({ environments: [] })).toThrow("the report has no environments");
  });

  test("refuses an environment that is not macOS", () => {
    expect(() => normaliseReport({ environments: [{ name: "bun", systemData: { osName: "ubuntu", osVersion: "24.04" } }] })).toThrow(
      'environment "bun" reports {"osName":"ubuntu","osVersion":"24.04"}, expected macos with a major.minor version',
    );
  });

  test("refuses a macOS version it cannot parse", () => {
    expect(() => normaliseReport({ environments: [macos("26")] })).toThrow('"osVersion":"26"}, expected macos with a major.minor version');
  });
});
