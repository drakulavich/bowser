// A HOME whose sessions root (`<HOME>/.bowser/sessions`) has an exact length,
// built from nested directories so no component passes NAME_MAX. It lets a
// test put the session-name limit below 255 (F35).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT_SUFFIX = "/.bowser/sessions";

/** The HOME path under `base` whose sessions root is `rootLength` characters.
 *  Pure: nothing is created. */
export function longHomePath(base: string, rootLength: number): string {
  let home = base;
  const want = rootLength - ROOT_SUFFIX.length;
  if (want < base.length + 2) throw new Error(`longHomePath: ${rootLength} is too short for ${base}`);
  while (want - home.length > 201) home += "/" + "h".repeat(200);
  return home + "/" + "h".repeat(want - home.length - 1);
}

/** `longHomePath`, with the sessions root created. */
export async function longHome(base: string, rootLength: number): Promise<string> {
  const home = longHomePath(base, rootLength);
  await mkdir(join(home, ".bowser", "sessions"), { recursive: true });
  return home;
}
