# Agent benchmark: bowser and playwright-cli

Measured 2026-10-20 with claude-sonnet-5-5 in Claude Code 2.1.304:
- bowser 0.11.0+fa5ca41
- playwright-cli 0.1.13

Each task ran in a fresh `claude -p` with only that tool's own skill installed and Bash allowed only for the tool.
On macOS bowser drives WebKit and playwright-cli drives Chromium. Medians come from passing runs only.
Tokens are everything the agent processed: input, cache reads and writes, and output. Tool output is what the
tool's commands printed back to the agent. How to rerun: `bench/README.md`.

| Task | bowser pass | tokens | tool output | time | cost | playwright-cli pass | tokens | tool output | time | cost |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| login | 1/1 | 58.3k | 2.4k B | 22 s | $0.066 | 1/1 | 33.3k | 1.3k B | 21 s | $0.047 |
| search | 1/1 | 57.2k | 1.2k B | 13 s | $0.064 | 1/1 | 47.0k | 2.4k B | 12 s | $0.051 |
| form | 1/1 | 94.6k | 3.0k B | 21 s | $0.075 | 1/1 | 48.6k | 4.5k B | 28 s | $0.056 |
| read | 1/1 | 58.7k | 3.2k B | 13 s | $0.066 | 1/1 | 34.1k | 3.5k B | 10 s | $0.050 |
| compare | 1/1 | 57.4k | 0.2k B | 19 s | $0.066 | 1/1 | 33.5k | 1.5k B | 11 s | $0.048 |
| paginate | 1/1 | 74.2k | 0.2k B | 20 s | $0.069 | 1/1 | 59.4k | 0.4k B | 21 s | $0.054 |
| todo | 1/1 | 110.7k | 3.1k B | 14 s | $0.078 | 1/1 | 88.2k | 1.8k B | 28 s | $0.061 |
| dynamic | 1/1 | 57.5k | 1.1k B | 18 s | $0.064 | 1/1 | 33.2k | 0.9k B | 22 s | $0.046 |
| table | 1/1 | 40.4k | 0.2k B | 12 s | $0.060 | 1/1 | 33.1k | 1.0k B | 13 s | $0.046 |
| session | 1/1 | 58.3k | 2.7k B | 15 s | $0.067 | 1/1 | 46.8k | 2.1k B | 19 s | $0.050 |
| **sum of medians** | 10/10 | 667.2k | 17.4k B | 167 s | $0.674 | 10/10 | 457.2k | 19.3k B | 185 s | $0.509 |

⚠ marks a task that did not pass every run; its medians cover the passing runs.
