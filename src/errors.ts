// A leaf module: no imports, so any layer may throw one.

/** A mistake in how bowser was called, or a state the user must fix first
 *  (no open page, a ref that is gone, a session whose browser exited): the
 *  CLI exits 1. Every other error exits 2. The class decides, never the
 *  message, so a page error that happens to read `usage: …` is still exit 2.
 *  Only the CLI process throws one; no user error crosses the daemon socket. */
export class UserError extends Error {}
