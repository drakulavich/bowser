// SCHEMAS now lives with the registry it is derived from. This re-export
// keeps tests/compat.test.ts, tests/parse-args.test.ts and tests/cookie.test.ts
// importing the path they always did.
export { SCHEMAS } from "./registry.ts";
