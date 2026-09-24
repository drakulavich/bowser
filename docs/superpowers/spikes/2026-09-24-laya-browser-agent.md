# Spike: a local browser agent on Laya, in Bun + TypeScript

**Status:** closed. It works, but on this laptop it is slow and it only
manages one-click tasks. Not worth a `bowser do` yet.
**Question:** can the open-weights Laya decision model replace TypeSafe Jev in
a [jev-ultrafast][jev]-style agent, running locally from Bun + TypeScript and
driving Microsoft Edge, with no Python at runtime?
**Machine:** MacBook, Apple M2, 16 GB RAM, CPU inference only. Edge 153,
Bun 1.4.2, onnxruntime-node 1.30.0, Ollama with `qwen3:4b`.
**Code:** throwaway and not in this repo. Everything a rebuild needs is
written down below.

## Background

TypeSafe **Jev** is a closed "System 1" decision model. You send it a state
and some typed questions (`choice`, `score`, `noul`). It answers with
probabilities instead of generated text, in about 150 ms
([Arize benchmark][arize]).

**jev-ultrafast** (browser-use, MIT) is a browser agent built on Jev. A step
works like this:

1. `snapshot.js` reads the page into an indexed table of visible controls,
   with no screenshots.
2. One Jev request asks several `choice` questions at once. One question picks
   the operation (`CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_*`, `WAIT`, `DONE`,
   `BLOCKED`). There is one more question per operation that picks its
   target.
3. A small OpenAI-compatible LLM writes the value, only for `TYPE_TEXT`.
4. Freshness guards re-check the page before every input.

**Laya** (Convai Innovations, Apache-2.0) is the open copy of Jev
([dev.to comparison][devto]): a 421M ModernBERT encoder with a decision head.
It uses the same request and response shape as Jev's `/v1/systemone`.

## Findings

### 1. Base Laya cannot drive a browser; the browser fine-tune can

The base checkpoints are close to random without fine-tuning. Laya's own docs
(Context7 `/nandhakishorm/laya`) say "treat Laya as a fast base to specialise,
not as a zero-shot decision engine". The first smoke test agreed: on a
Wikipedia page it chose `DONE` and the "Main page" link for a search goal.

[`cklxx/laya-browser`][cklxx] fine-tunes Laya for jev-ultrafast on Mind2Web
plus 5k synthetic goals and DAgger corrections. It publishes three
checkpoints and its full pipeline. This spike used **v10s** (mmBERT-base,
322M, about 0.65 GB):

| | base laya | laya-browser v10s (their numbers) |
|---|---|---|
| element top-1, ~45 candidates | 0.10 | 0.63 |
| operation accuracy | 0.54 | 0.89 |
| 16 live tasks × 3 runs | 0 % | 62 % |
| per step, RTX 4070 Ti | 50 to 200 ms | 17 to 23 ms |

Two of their negative results are worth keeping:
- Sending low-confidence decisions to Qwen3-8B made results worse (58 % → 42 %).
- Laya degrades above about 20 options unless `head_max_len` is raised. v10s
  trains with 768.

### 2. It runs in Bun without Python, after a one-time export

The fine-tuned weights come as PyTorch `model.safetensors`. There is no ONNX
build: `ddoice/laya-browser-onnx` on the Hub is empty. Converting needs Python
exactly once:

```bash
# isolated uv env: torch, transformers>=4.56, safetensors, onnx, onnxscript, onnxruntime
cp rl_common.py v10s/        # from convaiinnovations/laya; export_onnx.py imports build_model from it
uv run python receptron-laya/export/export_onnx.py v10s v10s-onnx
# -> max |dlogits| = 5e-05 against PyTorch, single 1.3 GB fp32 laya.onnx
```

Runtime is [`@receptron/laya`][receptron]'s approach on `onnxruntime-node`,
which works under Bun. Its prebuilt darwin-arm64 binary ships in the package,
so the blocked `postinstall` does not need to run. Three things had to change
for v10s:

- **Special tokens.** receptron hardcodes ModernBERT's `[CLS]`, `[SEP]`,
  `[MASK]` and `[PAD]`. mmBERT uses `<bos>`, `<eos>`, `<mask>` and `<pad>`.
  Read them from `tokenizer/tokenizer_config.json` (`cls_token`, `sep_token`,
  `mask_token`, `pad_token`), as `rl_common.build_sequence` does.
- **Format v3.** This is the input format v10s was trained on. It lives in
  cklxx's `code/apps/systemone_server.py`:
  - The state keeps only `page.{url,title,text[:1200]}` and `recent_actions`.
    The element table is not in the state.
  - Each element becomes one option string:
    `"[i] label[:50] (role) = 'value'[:30] checked=… selected=… expanded=…"`.
  - Run without chunking (`MAXOPT=999`), with `head_max_len` 768.
- **Validation.** On cklxx's recorded step (`code/sample_request.json`) the
  answer was `TYPE_TEXT → [2] Search Wikipedia (searchbox)`, confidence 0.92,
  the same as their label.

### 3. Quality on Edge matches the reference

The agent was a TypeScript port of jev-ultrafast's loop: `snapshot.js`
verbatim, the `model.choose` questions verbatim, and the same freshness
guards. Edge was driven over CDP with Bun's built-in `WebSocket`. The run used
cklxx's task suite (`code/apps/browser_suite.py`), same goals and checks,
minus Google Flights, one run each:

| task | result | actions | wall |
|---|---|---|---|
| hn-new | pass | 1 | 6.9 s |
| hn-login-page | pass | 1 | 5.5 s |
| hn-past | pass | 1 | 6.7 s |
| py-downloads | pass | 1 | 10.4 s |
| books-travel | pass | 1 | 7.0 s |
| books-open-book | pass | 1 | 6.0 s |
| quotes-tag-love | pass | 1 | 6.3 s |
| internet-dropdown | pass | 1 | 3.0 s |
| internet-checkbox | pass | 1 | 1.9 s |
| wiki-einstein | fail: clicked, then `DONE` on Main Page | 1 | 13.2 s |
| wiki-search | fail\* | 2 | 37.2 s |
| gh-issues | fail: clicked Issues, URL unchanged, `DONE` | 1 | 9.9 s |
| books-page2 | fail: "next" is below the fold, so it clicked the first book | 1 | 6.1 s |
| ddg-search | fail: clicked "Duck.ai", then `DONE` | 1 | 3.5 s |
| arxiv-search | fail: typed the query, then 3× `CLICK` "Astrophysics" (rejected) | 2 | 32.0 s |

**9 of 15.** cklxx got 10 of 16 on GPU, and the failing tasks are nearly the
same set, so the port reproduces their model's behaviour.

\* The suite's check (`"Python" in title`) marks wiki-search as a pass. It is
not a pass: the text helper typed the whole goal into the search box, and the
agent stopped on the search results page, whose title contains the query.
Fix that check before trusting it.

What works is single-click navigation: links, tabs, `<select>` and
checkboxes. What fails is anything that needs a plan:
- type the text, then submit it or pick a suggestion;
- scroll to find the target;
- find a target that is not on screen yet.

In those cases the model clicks the closest-looking visible item and declares
`DONE`.

### 4. Speed on an M2 CPU is the real problem

39 decisions: min 0.44 s, **median 3.2 s**, max 6.1 s. That is about 150×
slower than cklxx's GPU numbers. The cost grows with page size, 1.4k to 3.9k
tokens per step. Each step is three sequences, one per question, and each one
carries the full page state, so nothing is shared between them.

The GPU did not help:

| execution provider | result |
|---|---|
| CPU | 3.8 s on the reference step |
| CoreML, default (dynamic shapes) | fails at init: `HandleNegativeAxis … axis 2 is not in valid range [-2,1]` |
| CoreML + `freeDimensionOverrides` (batch 3, seq 1024, options 64), MLProgram | loads, same 3.9 s: CoreML claims **132 of 1486 nodes** in 25 partitions, the rest stays on CPU |
| WebGPU inside Edge (`onnxruntime-web`) | not tried, out of scope for this spike |
| MLX | no usable JS binding |

The dynamo exporter produces ops that CoreML does not support. Fixing that
means a different export (TorchScript exporter or coremltools), which is
Python work again.

## Smaller things learned

- **Edge launch.** `--headless=new --remote-debugging-port=0
  --user-data-dir=<tmp>` works. Read `DevToolsActivePort` from the profile
  dir. Poll it with `existsSync`: a reused `Bun.file(...).exists()` kept
  answering `false` after the file appeared. Use a throwaway profile, so the
  agent never sees the user's cookies.
- **Text helper.** Ollama `qwen3:4b` with `response_format: json_object`
  echoes its input JSON back instead of answering, and truncates on real
  pages. A strict `json_schema` (`{text: string}`) fixes the format but not
  the judgement: it typed the whole goal into Wikipedia's search box.
- **Stall rule.** jev's rule (three no-op actions) never fires when every
  action is rejected by the freshness guard, because rejected actions never
  reach history. Count consecutive rejections as well.

## If this is picked up again

In order of cost:

1. **int8 dynamic quantization** of the exported graph. This is one more
   offline step and should give roughly 2× on CPU. Check it against the
   reference step and the suite.
2. **Ask fewer questions per step.** Choose the operation first, then only
   that operation's target. On pages with inputs this saves one of three
   encoder passes. It costs a second round-trip, but that round-trip is
   in-process.
3. **Fine-tune on our own trajectories.** All of the quality comes from
   fine-tuning, and the failure modes are exactly the multi-step flows missing
   from cklxx's data (type→submit, scroll-then-click). Their pipeline
   (`code/finetune/`) runs on one 16 GB GPU in one to two hours, and Kaggle's free T4s
   would work.
4. Only then consider `bowser do "<goal>"`. bowser already owns the
   snapshot, the refs and the daemon. The model would sit behind a new daemon
   op, and its first-load cost (about 1 s warm, 1.3 GB) would be paid once
   per session.

To rebuild the spike you need: `@receptron/laya`'s `src/laya.ts` and
`sequence.ts` with the special-token change above; jev-ultrafast's
`snapshot.js` and `questions.py` texts; a CDP client for `observe`, `fresh`
and `act` (a port of `browser.py`); and the format-v3 `compact()`. The whole
spike was about 530 lines of TypeScript.

[jev]: https://github.com/browser-use/jev-ultrafast
[arize]: https://arize.com/blog/jev-llm-judge-benchmark/
[devto]: https://dev.to/jamilxt/jev-vs-laya-the-same-ai-idea-one-closed-and-one-open-3c6e
[cklxx]: https://huggingface.co/cklxx/laya-browser
[receptron]: https://github.com/receptron/laya
