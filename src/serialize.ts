// Primitives for the daemon: run browser operations one at a time (the single
// Bun.WebView can't handle a second evaluate() while one is pending), and bound
// each operation so a wedged WebKit call surfaces as an error instead of hanging.

/** Returns a function that queues async work so each call runs strictly after
 *  the previous one settles — one operation at a time, across all callers. */
export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // Run after the previous task settles, regardless of its outcome. Using
    // arrow wrappers (not `tail.then(task, task)`) keeps task zero-arg — a
    // rejection reason can never leak in as an argument.
    const run = tail.then(() => task(), () => task());
    // Keep tail's rejection handled so the chain continues; `run` still
    // propagates the rejection to the caller.
    tail = run.catch(() => {});
    return run;
  };
}

/** Reject with a clear, labelled error if `p` does not settle within `ms`.
 *  When `ms <= 0` the timeout is disabled and `p` is returned unchanged. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (!(ms > 0)) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`operation '${label}' timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
