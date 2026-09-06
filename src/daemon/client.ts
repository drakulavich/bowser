import { join } from "node:path";
import { sessionsRoot } from "../state.ts";

export function socketPath(session: string): string {
  // Use a short path — Unix socket names have a ~104-char limit on macOS.
  return join(sessionsRoot(), session, "sock");
}
