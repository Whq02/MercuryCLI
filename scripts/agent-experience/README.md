# agent-experience — the cold-start benchmark

How well does a model drive Mercury's tools in its first session? This suite
measures it: thirteen realistic first-session tasks, run headless (`-p`) on the
built bundle in a scratch project with a scratch config home, scored per run.

```sh
bun run build.ts                                             # the bundle under test
bash scripts/agent-experience/benchmark.sh                   # mechanical legs, every family, zero spend
bash scripts/agent-experience/benchmark.sh --live            # + the live leg on the saved free default
bash scripts/agent-experience/benchmark.sh --families anthropic --tasks fix-bug,two-seats
bash scripts/agent-experience/benchmark.sh --record mechanical   # refresh the committed baseline
bash scripts/agent-experience/run-all.sh                     # the suite: laws + mechanical legs + ratchet
```

## The legs

- **Mechanical** — one leg per provider family on the loopback fixture
  (`lib/fixture.ts`): Anthropic Messages, OpenAI Responses, chat-completions
  on Z.AI, and the same wire on the OpenRouter carrier. A scripted model takes
  the competent path through each task, including the deliberate first-session
  mistakes harvested from the operator's reference session (an edit against
  unread text, a guessed parameter name, a call missing its required field, a
  guessed skill name, a failing shell run). Deterministic, no network, no
  spend. What it measures is the harness side: the bytes a model must read
  before its first move (system prompt, tool roster, schema size), the size of
  what comes back from tools, the text of every error, and whether each
  dialect's tool loop delivers parallel rounds, subagent seats and resumed
  sessions whole.
- **Live** (`--live`) — the operator's saved default model, read from the
  config home's `settings.json` and required to be an OpenRouter id (the free
  default; priced 0/0). The one real-model behaviour sample: turns, wasted
  calls, asks, success, on the same tasks and oracles.

Each mechanical leg carries only its own family's credential; every family's
base URL is pinned at the fixture so no boot probe leaves the machine
(`--bare-family-env` pins only the leg's own base — the literal one-provider
operator shape). `MERCURY_AX_DUMP_HITS=1` writes every request body the
fixture received beside the run (`<out>/<family>/runs/<task>.hit-N.<kind>.json`).

## The tasks

| id | the ask | oracle |
|---|---|---|
| fix-bug | the suite fails; find and fix the bug in src/stats.js, tests untouched | `node --test` exit 0; only src/stats.js changed |
| add-test | add a test for mean([]) = 0 and run the suite | test present, the new case passes, only the test file changed, a suite run happened |
| anchored-edit | change `## Usage` to `## Usage (CLI)`, nothing else | heading present; `git diff --numstat` = 1/1 on README.md alone |
| search-symbol | where is normalizeRecord defined and called (file:line) | the definition and call-site lines cited; a search tool used |
| shell-pipeline | count lines across src/*.js with one pipeline | the exact count cited; a piped Bash call |
| use-skill | use the provider-apis skill; which endpoint does Responses post to | the skill loaded (non-error result); the answer names responses |
| delegate-agent | a subagent reads the test file and reports coverage; relay it | the Agent result mentions median; the relay names mean and median |
| ide-diagnostics | open src/stats.js in the language server, report diagnostics | an LSP call whose result is not failed/unavailable |
| browser-page | open the fixture page, report its title, screenshot | a Browser result carries the title; the title is reported (skipped when no browser is installed) |
| guide-question | ask the guide agent how to change the permission mode | mechanical: the guide seat ran with the command roster; live: a real surface named (shift+tab, /authority, --permission-mode) |
| two-seats | two seats at once (count tests · list exports), merged | one assistant message with two Agent calls; both answered; both facts merged |
| structural-rename | rename normalizeRecord to normaliseRecord structurally across the three source files (declaration, imports, uses) with AstSearch/AstEdit | no normalizeRecord left in src; normaliseRecord in all three files; only the three source files changed; README untouched; an AstEdit apply with a plan token happened; node --test still loads the modules (2 pass, the pre-existing 1 fail) |
| resume-a / resume-b | remember a codeword; a second run resumes the session and recalls it | phase 2 recalls PELICAN-42; the resumed request carried the prior turn |

## The scores (per run)

`turns` (model round-trips) · `toolCalls` · `wasted` (error results + repeated
identical calls; `probes` are the script's deliberate mistakes, so
`unexpectedErrors = wasted − probes`) · `toolResultChars` / `toolResultTokensEst`
(what the model read back; image payloads counted apart as `imageChars`) ·
`asks` (permission denials plus ask-class results a headless run could not
answer) · `success` (the oracle) · wall time, exit code, result subtype ·
`errors[]` (every error text, and whether it names a fix).

Per family: prompt chars/≈tokens, tool count, tool-schema chars — from the
first request the fixture captured (`<out>/prompts/<family>.system.txt` holds
the assembled prompt as that wire carried it).

## Output

`<out>/<family>.json` (one table per family), `<out>/summary.md` (the rendered
matrix + prompt facts + error audit), `<out>/<family>/runs/<task>.jsonl` (the
raw envelopes), `<out>/prompts/`. `--record LABEL` copies the tables under
`baselines/LABEL/`; the suite ratchets against `baselines/mechanical/`.
