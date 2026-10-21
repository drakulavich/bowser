# Agent benchmark: bowser and playwright-cli

Measured 2026-10-21 with claude-sonnet-5-5 in Claude Code 2.1.305:
- bowser 0.11.0+d75069c
- playwright-cli 0.1.13

Each task ran in a fresh `claude -p` with only that tool's own skill installed and Bash allowed only for the tool.
On macOS bowser drives WebKit and playwright-cli drives Chromium. Medians come from passing runs only.
Tokens are everything the agent processed: input, cache reads and writes, and output. Tool output is what the
tool's commands printed back to the agent. How to rerun: `bench/README.md`.

| Task | bowser pass | tokens | tool output | time | cost | playwright-cli pass | tokens | tool output | time | cost |
|---|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| login | 3/3 | 40.3k | 2.1k B | 19 s | $0.041 | 3/3 | 33.3k | 1.3k B | 23 s | $0.047 |
| search | 3/3 | 39.3k | 1.1k B | 21 s | $0.039 | 3/3 | 47.5k | 2.4k B | 20 s | $0.052 |
| form | 3/3 | 41.2k | 3.0k B | 16 s | $0.043 | 3/3 | 48.6k | 4.5k B | 23 s | $0.056 |
| read | 3/3 | 29.6k | 3.5k B | 14 s | $0.040 | 3/3 | 34.0k | 3.5k B | 12 s | $0.049 |
| compare | 3/3 | 28.9k | 0.3k B | 13 s | $0.037 | 3/3 | 33.5k | 1.5k B | 15 s | $0.047 |
| paginate | 3/3 | 50.6k | 0.2k B | 21 s | $0.045 | 3/3 | 59.6k | 0.4k B | 27 s | $0.055 |
| todo | 3/3 | 74.3k | 2.2k B | 16 s | $0.049 | 3/3 | 75.1k | 1.8k B | 20 s | $0.061 |
| dynamic | 3/3 | 39.6k | 1.2k B | 19 s | $0.039 | 3/3 | 33.2k | 0.9k B | 22 s | $0.046 |
| table | 3/3 | 28.5k | 0.2k B | 18 s | $0.035 | 3/3 | 33.1k | 1.0k B | 17 s | $0.046 |
| session | 3/3 | 40.4k | 2.5k B | 16 s | $0.042 | 3/3 | 46.8k | 2.1k B | 20 s | $0.050 |
| **sum of medians** | 30/30 | 412.7k | 16.2k B | 173 s | $0.409 | 30/30 | 444.6k | 19.3k B | 199 s | $0.509 |

⚠ marks a task that did not pass every run; its medians cover the passing runs.
