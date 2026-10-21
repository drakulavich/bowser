# Agent benchmark

Ten browser tasks, each given to the same Claude Code agent once with bowser and once with
playwright-cli. Design and method: `docs/superpowers/specs/2026-10-19-agent-benchmark-design.md`.
Latest results: `docs/benchmark.md`.

You need Claude Code logged in, `bowser` and `playwright-cli` on `PATH`, and no browser session
open in either tool (the runner refuses to start otherwise).

    bun bench/run.ts --dry-run                 # the 60 planned runs
    bun bench/run.ts --task login --reps 1     # one task, one run per tool
    bun bench/run.ts                           # everything: 10 tasks × 2 tools × 3 reps
    bun bench/report.ts bench/results/<date>.jsonl

Rows append to `bench/results/<date>.jsonl`; full agent streams go to the gitignored
`.bench/streams/<date>/`. The full run on 2026-10-21 cost $2.75 of Claude usage and took 11 minutes.
