// State persisted between CLI invocations.
// One-shot mode means each command spawns a fresh WebView, so we need to
// persist just enough to make multi-step flows work:
//   - the current URL (so we can re-navigate)
//   - the last snapshot (so @eN refs resolve to CSS selectors)
//
// State lives under ~/.bowser/sessions/<name>/.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Ref {
  id: string; // "e1", no '@' prefix (playwright-cli compatible)
  selector: string;
  role: string;
  name: string;
  tag: string;
  href?: string;
  value?: string;
}

export interface SessionState {
  name: string;
  url: string;
  title: string;
  refs: Ref[];
  updatedAt: number;
}

const ROOT = join(homedir(), ".bowser", "sessions");

export function sessionDir(name: string): string {
  return join(ROOT, name);
}

export async function ensureSessionDir(name: string): Promise<string> {
  const dir = sessionDir(name);
  await mkdir(dir, { recursive: true });
  return dir;
}

function statePath(name: string): string {
  return join(sessionDir(name), "state.json");
}

export async function loadState(name: string): Promise<SessionState | null> {
  const path = statePath(name);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as SessionState;
  } catch {
    return null;
  }
}

export async function saveState(state: SessionState): Promise<void> {
  await ensureSessionDir(state.name);
  await Bun.write(statePath(state.name), JSON.stringify(state, null, 2));
}

export async function clearState(name: string): Promise<void> {
  const path = statePath(name);
  const file = Bun.file(path);
  if (await file.exists()) {
    await Bun.write(path, ""); // truncate; leave dir for future
  }
}

export function resolveRef(state: SessionState, ref: string): Ref {
  if (!/^e\d+$/.test(ref)) {
    throw new Error(
      `expected a ref like 'e1', got '${ref}'. Run 'bowser snapshot' first.`,
    );
  }
  const found = state.refs.find((r) => r.id === ref);
  if (!found) {
    throw new Error(
      `ref '${ref}' not found in last snapshot of session '${state.name}'. ` +
        `Run 'bowser snapshot' to refresh.`,
    );
  }
  return found;
}
