/** A Clock for wrapView that starts at 0 and moves only inside `settledAt`. */
export function manualClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  // setImmediate runs after every queued promise callback.
  const drain = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      timers.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(timer: unknown) { timers.delete(timer as number); },
    /** Fire timers in order until `p` settles; answers the clock time it settled at. */
    async settledAt(p: Promise<unknown>, capMs = 60_000): Promise<number> {
      let at: number | undefined;
      p.then(() => { at = now; }, () => { at = now; });
      for (;;) {
        await drain();
        if (at !== undefined) return at;
        let id: number | undefined;
        for (const [k, t] of timers) if (t.at <= capMs && (id === undefined || t.at < timers.get(id)!.at)) id = k;
        if (id === undefined) throw new Error(`still pending at clock ${now} ms`);
        const t = timers.get(id)!;
        timers.delete(id);
        now = t.at;
        t.fn();
      }
    },
    /** As settledAt, but a rejected `p` fails the caller. */
    async fulfilledAt(p: Promise<unknown>, capMs?: number): Promise<number> {
      const at = await this.settledAt(p, capMs);
      await p;
      return at;
    },
  };
}
