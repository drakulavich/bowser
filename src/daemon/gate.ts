export interface Gate {
  /** Resolves when `conn` holds the gate (at once if it already does), with
   *  `done`, to call when this request has settled. Rejects if `conn`
   *  leaves before its turn. */
  enter(conn: object): Promise<() => void>;
  /** `conn`'s socket closed: drop it from the queue, or release the gate
   *  once its entered requests are all done. */
  leave(conn: object): void;
}

interface Waiter {
  resolve: (done: () => void) => void;
  reject: (err: Error) => void;
}

/** A FIFO gate whose holders are connections. The holder passes it on when it
 *  leaves with no request in flight, or after `idleMs` with none (never when
 *  `idleMs <= 0`). */
export function createGate(idleMs: number): Gate {
  let holder: object | null = null;
  let active = 0;
  let leaving = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const queue = new Map<object, Waiter[]>();

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function grant(waiter: Waiter): void {
    active++;
    let settled = false;
    waiter.resolve(() => {
      if (settled) return;
      settled = true;
      active--;
      if (active > 0) return;
      if (leaving) release();
      else if (idleMs > 0) idleTimer = setTimeout(release, idleMs);
    });
  }

  function release(): void {
    clearIdle();
    holder = null;
    active = 0;
    leaving = false;
    const next = queue.entries().next();
    if (next.done) return;
    const [conn, waiters] = next.value;
    queue.delete(conn);
    holder = conn;
    for (const w of waiters) grant(w);
  }

  return {
    enter(conn) {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (holder === null) holder = conn;
        if (holder === conn) {
          clearIdle();
          grant(waiter);
          return;
        }
        const waiters = queue.get(conn);
        if (waiters) waiters.push(waiter);
        else queue.set(conn, [waiter]);
      });
    },
    leave(conn) {
      const waiters = queue.get(conn);
      if (waiters) {
        queue.delete(conn);
        for (const w of waiters) w.reject(new Error("connection closed before its turn at the gate"));
      }
      if (holder !== conn) return;
      if (active === 0) release();
      else leaving = true;
    },
  };
}
