# Glossary

Canonical terms for the bowser spec corpus. Specs use these terms verbatim; if you
need a new term, add it here first.

| Term | Definition |
|---|---|
| **bowser** | This project: a Bun-native browser-automation CLI, published as `@drakulavich/bowser-cli`, command `bowser`. |
| **CLI** | The `bowser` command — TypeScript executed by Bun, dispatched in `src/cli.ts` (per-command flags in `src/cli/schemas.ts`, implementations in `src/commands.ts`). |
| **playwright-cli compatibility** | bowser's core command surface mirrors Microsoft `playwright-cli` byte-for-byte (commands, flag syntax, snapshot YAML), so existing playwright skills run unchanged. Enforced by `tests/compat.test.ts`. |
| **Session** | A named, persistent browsing context backed by one long-lived browser process; selected with `-s`/`--session`. State persists under `~/.bowser/sessions/<name>/state.json` (`src/state.ts`). |
| **Daemon** | The per-session background process that holds the `Bun.WebView` and answers requests over a Unix socket, serializing operations one at a time. Spawned via `src/daemon-main.ts`; the request handler and op union live in `src/daemon.ts`, the serializer in `src/serialize.ts`. |
| **Bun.WebView** | The Bun ≥ 1.3.12 API bowser drives the browser through (`src/browser.ts`). |
| **Backend** | The browser engine behind the Daemon: **WebKit** (macOS native default) or **Chrome/Chromium** over the DevTools Protocol; chosen by `resolveBackend` (`src/browser.ts`). |
| **CDP** | Chrome DevTools Protocol — the wire protocol used to drive the Chrome/Chromium Backend (and the only Backend that supports `cookie-*`). |
| **Explicit Chromium opt-in** | On **macOS** bowser defaults to native WebKit and uses Chrome only when explicitly enabled — the bowser-managed cache exists or `BOWSER_CHROMIUM_PATH` is set (`hasExplicitChromium`) — never incidental system Chrome. On **Linux/Windows** there is no native WebKit, so Chrome/Chromium over CDP is the default Backend. `BOWSER_BACKEND=webkit\|chrome` overrides everywhere. |
| **Ref** | A bare `eN` handle (no `@` prefix) for an interactive element on the current page, resolved to a stable CSS path via `resolveRef`/`loadRef` and persisted in Session state. |
| **Snapshot** | The aria-tree YAML listing of interactive Refs for the current page (`src/snapshot.ts`), byte-for-byte compatible with playwright-cli; `--json` emits the structured shape, `--depth=N` clips landmark nesting. |
| **Interactive element** | A DOM element the Snapshot script selects and assigns a Ref (buttons, links, inputs, …). |
| **Actionability auto-wait** | `Bun.WebView`'s built-in wait for an element to be ready before an action dispatches — bowser does no polling or hard-coded timeouts. |
| **Command** | One verb in the public surface (the ~25 rows of README.md's reference table), e.g. `open`, `snapshot`, `click`, `cookie-clear`. |
| **`--session` / `-s`** | The global flag selecting which Session a Command targets; defaults to the implicit session. |
| **`--json`** | The global flag switching a Command's output to machine-readable JSON on stdout. |
| **Exit code** | Process status from the CLI: **0** success, **1** user error (usage, unknown command, missing/unknown ref, no open page), **2** runtime error (`src/cli.ts` `import.meta.main`). |
| **install** | `bowser install` downloads and caches a Chromium build (`chrome-headless-shell`) under `~/.bowser/chromium/`; never auto-runs. |
| **eval / run-code** | Scripting Commands that execute JavaScript in the page (`eval`) or a code block (`run-code`) via the Daemon. |
| **SKILL.md** | `skills/bowser/SKILL.md` — the agent-facing skill description that documents the command surface in a few hundred tokens. |
