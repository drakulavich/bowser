/** Per-command timeout budget. Default 30s; override with BOWSER_OP_TIMEOUT_MS
 *  (set to 0 to disable). Guards a wedged WebKit call from hanging forever. */
export function opTimeoutMs(): number {
  const raw = process.env.BOWSER_OP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 30000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
}
