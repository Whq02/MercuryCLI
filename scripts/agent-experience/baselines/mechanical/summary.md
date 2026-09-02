# Agent-experience benchmark — 4004072fd

Tree 4004072fd · unlabelled · 2026-09-02T03:08:57.436Z

Cell legend: PASS/FAIL (the oracle) · t = model turns · w = wasted tool calls (p = the script's deliberate probes) · r = tokens read from tool results (est. chars/4; +img = screenshot payload; +inj = harness-injected text such as a skill expansion, shown from 200) · a = asks/denials that a headless run could not answer.

| task | anthropic | openai | chat | openrouter |
|---|---|---|---|---|
| fix-bug — find and fix a bug | PASS · t5 · w1(1p) · r595 · a0 | PASS · t5 · w1(1p) · r665 · a0 | PASS · t5 · w1(1p) · r664 · a0 | PASS · t5 · w1(1p) · r666 · a0 |
| add-test — add a test and run it | PASS · t4 · w0 · r334 · a0 | PASS · t4 · w0 · r403 · a0 | PASS · t4 · w0 · r402 · a0 | PASS · t4 · w0 · r405 · a0 |
| anchored-edit — edit a file precisely | PASS · t4 · w1(1p) · r170 · a0 | PASS · t4 · w1(1p) · r239 · a0 | PASS · t4 · w1(1p) · r239 · a0 | PASS · t4 · w1(1p) · r240 · a0 |
| search-symbol — search the repo for a symbol | PASS · t3 · w1(1p) · r303 · a0 | PASS · t2 · w1(1p) · r252 · a0 | PASS · t2 · w1(1p) · r249 · a0 | PASS · t2 · w1(1p) · r258 · a0 |
| shell-pipeline — run a shell pipeline and read its output | PASS · t2 · w0 · r2 · a0 | PASS · t2 · w0 · r2 · a0 | PASS · t2 · w0 · r2 · a0 | PASS · t2 · w0 · r2 · a0 |
| use-skill — use a bundled skill | PASS · t4 · w1(1p) · r49 +inj854 · a0 | PASS · t4 · w1(1p) · r49 +inj854 · a0 | PASS · t4 · w1(1p) · r49 +inj854 · a0 | PASS · t4 · w1(1p) · r49 +inj854 · a0 |
| delegate-agent — delegate a subtask to an agent | PASS · t2 · w0 · r145 · a0 | PASS · t2 · w0 · r145 · a0 | PASS · t2 · w0 · r145 · a0 | PASS · t2 · w0 · r145 · a0 |
| ide-diagnostics — open a file in the IDE seam | FAIL · t2 · w1 · r51 · a0 | FAIL · t1 · w1 · r0 · a0 | FAIL · t1 · w1 · r0 · a0 | FAIL · t1 · w1 · r0 · a0 |
| browser-page — drive the browser tool on a fixture page | PASS · t5 · w1(1p) · r114 +img19k · a0 | PASS · t5 · w1(1p) · r113 +img19k · a0 | PASS · t5 · w1(1p) · r132 · a0 | PASS · t5 · w1(1p) · r134 · a0 |
| guide-question — ask the guide agent a how-do-I question | PASS · t2 · w0 · r179 · a0 | PASS · t2 · w0 · r179 · a0 | PASS · t2 · w0 · r179 · a0 | PASS · t2 · w0 · r179 · a0 |
| two-seats — coordinate two seats | PASS · t3 · w0 · r227 · a0 | PASS · t3 · w0 · r228 · a0 | PASS · t3 · w0 · r227 · a0 | PASS · t3 · w0 · r228 · a0 |
| structural-rename — rename a function structurally across three files | PASS · t6 · w1(1p) · r706 · a0 | PASS · t6 · w1(1p) · r705 · a0 | PASS · t6 · w1(1p) · r704 · a0 | PASS · t6 · w1(1p) · r707 · a0 |
| resume-a — resume a session (phase 1: the codeword) | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 |
| resume-b — resume a session (phase 2: recall) | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 |
| **totals** | 13/14 pass · t44 · w7 (unexpected 1) · r2.9k · a0 · 23s | 13/14 pass · t42 · w7 (unexpected 1) · r3.0k · a0 · 23s | 13/14 pass · t42 · w7 (unexpected 1) · r3.0k · a0 · 22s | 13/14 pass · t42 · w7 (unexpected 1) · r3.0k · a0 · 22s |

## What the model reads before its first move

| family | model | backend | dialect | prompt chars | ≈tokens | tools | tool-schema chars |
|---|---|---|---|---|---|---|---|
| anthropic | claude-opus-4-8 | anthropic-messages | anthropic | 27484 | 6871 | 21 | 61685 |
| openai | gpt-5.5 | openai-responses | responses | 27330 | 6833 | 21 | 61811 |
| chat | glm-5.3 | zai-glm | chat | 27320 | 6830 | 21 | 62047 |
| openrouter | openrouter/stealth/ox-alpha | openrouter-chat | chat | 27340 | 6835 | 21 | 62047 |

## Error audit — what a model reads back when a call goes wrong

### anthropic

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.497875ms) ✔ median of an odd-length list (0.092ms) ✖ median of an even-length list averages the middle pair (0.854291ms) ℹ tests 3 ℹ suites 0 ℹ pass `
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content.</tool_use_error>`
- **search-symbol / Grep** (probe) — names a fix: yes — `<tool_use_error>InputValidationError: The Grep tool failed due to the following issues: The required parameter `pattern` is missing The parameter `query` was not expected</tool_use_error>`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **ide-diagnostics / LSP** — names a fix: yes — `<tool_use_error>No such tool available: LSP. It is not in this session's tool list — call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).</tool_use_error>`
- **browser-page / Browser** (probe) — names a fix: yes — `<tool_use_error>open requires an http(s) url</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

### openai

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.537417ms) ✔ median of an odd-length list (0.101875ms) ✖ median of an even-length list averages the middle pair (0.532167ms) ℹ tests 3 ℹ suites 0 ℹ pa`
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content.</tool_use_error>`
- **search-symbol / Grep** (probe) — names a fix: yes — `[openai] the provider emitted a malformed tool call (Grep): the arguments do not match the tool's input schema (The required parameter `pattern` is missing; The parameter `query` was not expected) — it was not executed.`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **ide-diagnostics / ?** — names a fix: yes — `[openai] No such tool available: LSP — it is not in this session's tool list, so it was not executed. Call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).`
- **browser-page / Browser** (probe) — names a fix: yes — `<tool_use_error>open requires an http(s) url</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

### chat

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.478917ms) ✔ median of an odd-length list (0.091958ms) ✖ median of an even-length list averages the middle pair (0.543125ms) ℹ tests 3 ℹ suites 0 ℹ pa`
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content.</tool_use_error>`
- **search-symbol / Grep** (probe) — names a fix: yes — `[zai] the provider emitted a malformed tool call (Grep): the arguments do not match the tool's input schema (The required parameter `pattern` is missing; The parameter `query` was not expected) — it was not executed.`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **ide-diagnostics / ?** — names a fix: yes — `[zai] No such tool available: LSP — it is not in this session's tool list, so it was not executed. Call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).`
- **browser-page / Browser** (probe) — names a fix: yes — `<tool_use_error>open requires an http(s) url</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

### openrouter

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.4685ms) ✔ median of an odd-length list (0.089084ms) ✖ median of an even-length list averages the middle pair (0.523292ms) ℹ tests 3 ℹ suites 0 ℹ pass`
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content.</tool_use_error>`
- **search-symbol / Grep** (probe) — names a fix: yes — `[openrouter] the provider emitted a malformed tool call (Grep): the arguments do not match the tool's input schema (The required parameter `pattern` is missing; The parameter `query` was not expected) — it was not execut`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **ide-diagnostics / ?** — names a fix: yes — `[openrouter] No such tool available: LSP — it is not in this session's tool list, so it was not executed. Call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).`
- **browser-page / Browser** (probe) — names a fix: yes — `<tool_use_error>open requires an http(s) url</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

## Oracle detail

### anthropic

- fix-bug: PASS — node --test exit 0; changed files: src/stats.js; final: Fixed median() in src/stats.js: an even-length list now averages its two middle 
- add-test: PASS — test present: true; new case passes: true; changed: test/stats.test.js; suite run: true
- anchored-edit: PASS — heading present: true; numstat: 1	1	README.md; changed: README.md
- search-symbol: PASS — definition cited: true; call site cited: true; searched: true
- shell-pipeline: PASS — expected 45; cited: true; pipeline used: true
- use-skill: PASS — provider-apis loaded: true; answer names responses: true
- delegate-agent: PASS — agent reported: true; relayed: true; seat ran its script: true
- ide-diagnostics: FAIL — LSP called: true; server answered: false; first result: <tool_use_error>No such tool available: LSP. It is not in this session's tool list — call one of the tools you were give
- browser-page: PASS — title in a Browser result: true; title reported: true
- guide-question: PASS — guide seat request: true; guide prompt: true; roster carries /authority: true; relayed: true
- two-seats: PASS — agent calls: 2; one parallel round: true; both seats answered with their facts: true; merged: true
- structural-rename: PASS — old name gone: true; new name in all three: true; changed: src/format.js, src/records.js, src/stats.js; README intact: true; structural apply: true; modules load (2 pass, 1 fail as before): true (2/1)
- resume-a: PASS — final: noted
- resume-b: PASS — recalled: true; resumed request carried the prior turn: true

### openai

- fix-bug: PASS — node --test exit 0; changed files: src/stats.js; final: Fixed median() in src/stats.js: an even-length list now averages its two middle 
- add-test: PASS — test present: true; new case passes: true; changed: test/stats.test.js; suite run: true
- anchored-edit: PASS — heading present: true; numstat: 1	1	README.md; changed: README.md
- search-symbol: PASS — definition cited: true; call site cited: true; searched: true
- shell-pipeline: PASS — expected 45; cited: true; pipeline used: true
- use-skill: PASS — provider-apis loaded: true; answer names responses: true
- delegate-agent: PASS — agent reported: true; relayed: true; seat ran its script: true
- ide-diagnostics: FAIL — LSP called: false; server answered: false; first result: 
- browser-page: PASS — title in a Browser result: true; title reported: true
- guide-question: PASS — guide seat request: true; guide prompt: true; roster carries /authority: true; relayed: true
- two-seats: PASS — agent calls: 2; one parallel round: true; both seats answered with their facts: true; merged: true
- structural-rename: PASS — old name gone: true; new name in all three: true; changed: src/format.js, src/records.js, src/stats.js; README intact: true; structural apply: true; modules load (2 pass, 1 fail as before): true (2/1)
- resume-a: PASS — final: noted
- resume-b: PASS — recalled: true; resumed request carried the prior turn: true

### chat

- fix-bug: PASS — node --test exit 0; changed files: src/stats.js; final: Fixed median() in src/stats.js: an even-length list now averages its two middle 
- add-test: PASS — test present: true; new case passes: true; changed: test/stats.test.js; suite run: true
- anchored-edit: PASS — heading present: true; numstat: 1	1	README.md; changed: README.md
- search-symbol: PASS — definition cited: true; call site cited: true; searched: true
- shell-pipeline: PASS — expected 45; cited: true; pipeline used: true
- use-skill: PASS — provider-apis loaded: true; answer names responses: true
- delegate-agent: PASS — agent reported: true; relayed: true; seat ran its script: true
- ide-diagnostics: FAIL — LSP called: false; server answered: false; first result: 
- browser-page: PASS — title in a Browser result: true; title reported: true
- guide-question: PASS — guide seat request: true; guide prompt: true; roster carries /authority: true; relayed: true
- two-seats: PASS — agent calls: 2; one parallel round: true; both seats answered with their facts: true; merged: true
- structural-rename: PASS — old name gone: true; new name in all three: true; changed: src/format.js, src/records.js, src/stats.js; README intact: true; structural apply: true; modules load (2 pass, 1 fail as before): true (2/1)
- resume-a: PASS — final: noted
- resume-b: PASS — recalled: true; resumed request carried the prior turn: true

### openrouter

- fix-bug: PASS — node --test exit 0; changed files: src/stats.js; final: Fixed median() in src/stats.js: an even-length list now averages its two middle 
- add-test: PASS — test present: true; new case passes: true; changed: test/stats.test.js; suite run: true
- anchored-edit: PASS — heading present: true; numstat: 1	1	README.md; changed: README.md
- search-symbol: PASS — definition cited: true; call site cited: true; searched: true
- shell-pipeline: PASS — expected 45; cited: true; pipeline used: true
- use-skill: PASS — provider-apis loaded: true; answer names responses: true
- delegate-agent: PASS — agent reported: true; relayed: true; seat ran its script: true
- ide-diagnostics: FAIL — LSP called: false; server answered: false; first result: 
- browser-page: PASS — title in a Browser result: true; title reported: true
- guide-question: PASS — guide seat request: true; guide prompt: true; roster carries /authority: true; relayed: true
- two-seats: PASS — agent calls: 2; one parallel round: true; both seats answered with their facts: true; merged: true
- structural-rename: PASS — old name gone: true; new name in all three: true; changed: src/format.js, src/records.js, src/stats.js; README intact: true; structural apply: true; modules load (2 pass, 1 fail as before): true (2/1)
- resume-a: PASS — final: noted
- resume-b: PASS — recalled: true; resumed request carried the prior turn: true

