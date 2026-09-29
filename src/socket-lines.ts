// Reading newline-delimited text from a byte stream: the daemon socket, both
// ends. One decoder per connection, in streaming mode, because a read can end
// inside a multi-byte UTF-8 character; decoding each read on its own turned
// that character into U+FFFD on any message over the socket's ~8 KB read
// size (#75).

/** A reader for one connection: feed it every chunk in order; it calls
 *  `onLine` with each complete line, without its "\n". */
export function lineReader(onLine: (line: string) => void): (chunk: Uint8Array) => void {
  const decoder = new TextDecoder();
  let buf = "";
  return (chunk) => {
    buf += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      onLine(line);
    }
  };
}
