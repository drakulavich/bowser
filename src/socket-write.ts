// Backpressure-aware writing for the daemon's Unix sockets.
//
// Bun's low-level socket.write() may perform a PARTIAL write when the kernel
// send buffer is full, returning the number of bytes actually accepted. The
// caller must buffer the remainder and flush it when the socket fires `drain`.
// Skipping this silently truncates any payload larger than the send buffer
// (~8 KB on macOS Unix sockets) — which is what made `bowser screenshot`
// (a ~140 KB base64 PNG) hang: the reader never saw the closing newline.
//
// Queue lifecycle: if a peer disconnects without ever firing `drain`, any
// buffered chunks remain in `_wq` indefinitely. Callers MUST close/discard
// the socket on error — the daemon's socket `error` handler owns that cleanup
// once this writer is wired in.

export interface WritableSocket {
  // Bun sockets accept string | ArrayBufferView and return bytes written.
  write(data: Uint8Array): number;
}

interface WriteQueue {
  chunks: Uint8Array[];
  offset: number; // bytes of chunks[0] already written
}

function queueFor(socket: WritableSocket): WriteQueue {
  const s = socket as WritableSocket & { _wq?: WriteQueue };
  if (!s._wq) s._wq = { chunks: [], offset: 0 };
  return s._wq;
}

/** Encode `str` as UTF-8, enqueue it, and flush as far as the socket allows. */
export function socketWriteAll(socket: WritableSocket, str: string): void {
  const q = queueFor(socket);
  q.chunks.push(new Uint8Array(Buffer.from(str, "utf-8")));
  flushSocket(socket);
}

/** Flush buffered bytes until the socket stalls. Safe to call from `drain`. */
export function flushSocket(socket: WritableSocket): void {
  const q = queueFor(socket);
  while (q.chunks.length > 0) {
    const head = q.chunks[0];
    const n = socket.write(head.subarray(q.offset));
    if (n > 0) q.offset += n;
    if (q.offset >= head.length) {
      q.chunks.shift();
      q.offset = 0;
    } else {
      // Partial or zero write — wait for `drain` before retrying.
      break;
    }
  }
}
