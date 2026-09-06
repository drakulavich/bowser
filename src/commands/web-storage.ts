// Web Storage commands (localStorage and sessionStorage). Implemented via
// `evaluate` against the live page, so they require an open page in the
// session. Values are always strings — that's the Storage API surface, no
// JSON encoding is implied.

import {
  storageClearScript, storageDeleteScript, storageGetScript, storageListScript, storageSetScript,
} from "../page-scripts.ts";
import { reply, withClient, type CommandContext } from "./context.ts";

async function storageList(ctx: CommandContext, area: "localStorage" | "sessionStorage"): Promise<string> {
  return withClient(ctx, async (c) => {
    const entries = (await c.request("evaluate", [
      storageListScript(area),
    ])) as Record<string, string> | null;
    const obj = entries ?? {};
    if (ctx.json) return JSON.stringify(obj);
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    return keys.map((k) => `${k}=${obj[k]}`).join("\n");
  });
}

async function storageGet(
  ctx: CommandContext,
  area: "localStorage" | "sessionStorage",
  command: string,
  key: string,
): Promise<string> {
  if (!key) throw new Error(`usage: bowser ${command} <key>`);
  return withClient(ctx, async (c) => {
    const val = (await c.request("evaluate", [
      storageGetScript(area, key),
    ])) as string | null;
    return reply(ctx, { ok: true, key, value: val }, val ?? "");
  });
}

async function storageSet(
  ctx: CommandContext,
  area: "localStorage" | "sessionStorage",
  command: string,
  key: string,
  value: string,
): Promise<string> {
  if (!key) throw new Error(`usage: bowser ${command} <key> <value>`);
  if (value === undefined) throw new Error(`usage: bowser ${command} <key> <value>`);
  return withClient(ctx, async (c) => {
    await c.request("evaluate", [
      storageSetScript(area, key, value),
    ]);
    return reply(ctx, { ok: true, key, value }, `set ${key}`);
  });
}

async function storageDelete(
  ctx: CommandContext,
  area: "localStorage" | "sessionStorage",
  command: string,
  key: string,
): Promise<string> {
  if (!key) throw new Error(`usage: bowser ${command} <key>`);
  return withClient(ctx, async (c) => {
    await c.request("evaluate", [
      storageDeleteScript(area, key),
    ]);
    return reply(ctx, { ok: true, key }, `deleted ${key}`);
  });
}

async function storageClear(ctx: CommandContext, area: "localStorage" | "sessionStorage"): Promise<string> {
  return withClient(ctx, async (c) => {
    await c.request("evaluate", [storageClearScript(area)]);
    return reply(ctx, { ok: true }, "cleared");
  });
}

export const cmdLocalStorageList = (ctx: CommandContext) => storageList(ctx, "localStorage");
export const cmdLocalStorageGet = (ctx: CommandContext, key: string) =>
  storageGet(ctx, "localStorage", "localstorage-get", key);
export const cmdLocalStorageSet = (ctx: CommandContext, key: string, value: string) =>
  storageSet(ctx, "localStorage", "localstorage-set", key, value);
export const cmdLocalStorageDelete = (ctx: CommandContext, key: string) =>
  storageDelete(ctx, "localStorage", "localstorage-delete", key);
export const cmdLocalStorageClear = (ctx: CommandContext) => storageClear(ctx, "localStorage");

export const cmdSessionStorageList = (ctx: CommandContext) => storageList(ctx, "sessionStorage");
export const cmdSessionStorageGet = (ctx: CommandContext, key: string) =>
  storageGet(ctx, "sessionStorage", "sessionstorage-get", key);
export const cmdSessionStorageSet = (ctx: CommandContext, key: string, value: string) =>
  storageSet(ctx, "sessionStorage", "sessionstorage-set", key, value);
export const cmdSessionStorageDelete = (ctx: CommandContext, key: string) =>
  storageDelete(ctx, "sessionStorage", "sessionstorage-delete", key);
export const cmdSessionStorageClear = (ctx: CommandContext) => storageClear(ctx, "sessionStorage");
