# Agent-experience benchmark — ad7dbe74b

Tree ad7dbe74b · unlabelled · 2026-10-02T04:12:53.144Z

Cell legend: PASS/FAIL (the oracle) · t = model turns · w = wasted tool calls (p = the script's deliberate probes) · r = tokens read from tool results (est. chars/4; +img = screenshot payload; +inj = harness-injected text such as a skill expansion, shown from 200) · a = asks/denials that a headless run could not answer.

| task | anthropic | openai | chat | openrouter |
|---|---|---|---|---|
| fix-bug — find and fix a bug | PASS · t5 · w1(1p) · r655 · a0 | PASS · t5 · w1(1p) · r723 · a0 | PASS · t5 · w1(1p) · r723 · a0 | PASS · t5 · w1(1p) · r726 · a0 |
| add-test — add a test and run it | PASS · t4 · w0 · r393 · a0 | PASS · t4 · w0 · r462 · a0 | PASS · t4 · w0 · r461 · a0 | PASS · t4 · w0 · r464 · a0 |
| anchored-edit — edit a file precisely | PASS · t4 · w1(1p) · r312 · a0 | PASS · t4 · w1(1p) · r381 · a0 | PASS · t4 · w1(1p) · r380 · a0 | PASS · t4 · w1(1p) · r383 · a0 |
| search-symbol — search the repo for a symbol | PASS · t3 · w1(1p) · r136 · a0 | PASS · t2 · w1(1p) · r90 · a0 | PASS · t2 · w1(1p) · r90 · a0 | PASS · t2 · w1(1p) · r90 · a0 |
| shell-pipeline — run a shell pipeline and read its output | PASS · t2 · w0 · r48 · a0 | PASS · t2 · w0 · r48 · a0 | PASS · t2 · w0 · r48 · a0 | PASS · t2 · w0 · r48 · a0 |
| use-skill — use a bundled skill | PASS · t4 · w1(1p) · r49 +inj543 · a0 | PASS · t4 · w1(1p) · r49 +inj543 · a0 | PASS · t4 · w1(1p) · r49 +inj543 · a0 | PASS · t4 · w1(1p) · r49 +inj543 · a0 |
| delegate-agent — delegate a subtask to an agent | PASS · t2 · w0 · r145 · a0 | PASS · t2 · w0 · r145 · a0 | PASS · t2 · w0 · r145 · a0 | PASS · t2 · w0 · r145 · a0 |
| ide-diagnostics — open a file in the IDE seam | PASS · t2 · w0 · r24 · a0 | PASS · t2 · w0 · r24 · a0 | PASS · t2 · w0 · r24 · a0 | PASS · t2 · w0 · r24 · a0 |
| browser-page — drive the browser tool on a fixture page | skip (unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent) | skip (unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent) | skip (unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent) | skip (unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent) |
| guide-question — ask a how-do-I question about Mercury | PASS · t3 · w0 · r7 +inj2.2k · a0 | PASS · t3 · w0 · r7 +inj2.2k · a0 | PASS · t3 · w0 · r7 +inj2.2k · a0 | PASS · t3 · w0 · r7 +inj2.2k · a0 |
| two-seats — coordinate two seats | PASS · t3 · w0 · r228 · a0 | PASS · t3 · w0 · r228 · a0 | PASS · t3 · w0 · r227 · a0 | PASS · t3 · w0 · r228 · a0 |
| structural-rename — rename a function structurally across three files | PASS · t6 · w1(1p) · r736 · a0 | PASS · t6 · w1(1p) · r734 · a0 | PASS · t6 · w1(1p) · r733 · a0 | PASS · t6 · w1(1p) · r736 · a0 |
| resume-a — resume a session (phase 1: the codeword) | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 |
| resume-b — resume a session (phase 2: recall) | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 | PASS · t1 · w0 · r0 · a0 |
| **totals** | 13/13 pass (1 skipped) · t40 · w5 (unexpected 0) · r2.7k · a0 · 17s | 13/13 pass (1 skipped) · t39 · w5 (unexpected 0) · r2.9k · a0 · 16s | 13/13 pass (1 skipped) · t39 · w5 (unexpected 0) · r2.9k · a0 · 16s | 13/13 pass (1 skipped) · t39 · w5 (unexpected 0) · r2.9k · a0 · 17s |

## What the model reads before its first move

| family | model | backend | dialect | prompt chars | ≈tokens | tools | tool-schema chars |
|---|---|---|---|---|---|---|---|
| anthropic | claude-opus-4-8 | anthropic-messages | anthropic | 22745 | 5686 | 58 | 203024 |
| openai | gpt-5.5 | openai-responses | responses | 22586 | 5647 | 22 | 90387 |
| chat | glm-5.3 | zai-glm | chat | 22576 | 5644 | 57 | 202740 |
| openrouter | openrouter/stealth/ox-alpha | openrouter-responses | responses | 22596 | 5649 | 57 | 202752 |

Notes (anthropic): browser task unmeasured: no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent

Notes (openai): browser task unmeasured: no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent

Notes (chat): browser task unmeasured: no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent

Notes (openrouter): browser task unmeasured: no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent

## Error audit — what a model reads back when a call goes wrong

### anthropic

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.382667ms) ✔ median of an odd-length list (0.086708ms) ✖ median of an even-length list averages the middle pair (0.482416ms) ℹ tests 3 ℹ suites 0 ℹ pa`
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands). Read ownership/coverage`
- **search-symbol / Grep** (probe) — names a fix: yes — `<tool_use_error>InputValidationError: The Grep tool failed due to the following issues: The required parameter `pattern` is missing The parameter `query` was not expected</tool_use_error>`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

### openai

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.36275ms) ✔ median of an odd-length list (0.066584ms) ✖ median of an even-length list averages the middle pair (0.3705ms) ℹ tests 3 ℹ suites 0 ℹ pass `
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands). Read ownership/coverage`
- **search-symbol / Grep** (probe) — names a fix: yes — `[openai] the provider emitted a malformed tool call (Grep): the arguments do not match the tool's input schema (The required parameter `pattern` is missing; The parameter `query` was not expected) — it was not executed.`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

### chat

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.43225ms) ✔ median of an odd-length list (0.091917ms) ✖ median of an even-length list averages the middle pair (0.418709ms) ℹ tests 3 ℹ suites 0 ℹ pas`
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands). Read ownership/coverage`
- **search-symbol / Grep** (probe) — names a fix: yes — `[zai] the provider emitted a malformed tool call (Grep): the arguments do not match the tool's input schema (The required parameter `pattern` is missing; The parameter `query` was not expected) — it was not executed.`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
- **structural-rename / AstEdit** (probe) — names a fix: yes — `<tool_use_error>apply: true needs plan — run the dry run first (the same call without apply), read the diff, then use the plan token it returned as plan.</tool_use_error>`

### openrouter

- **fix-bug / Bash** (probe) — names a fix: yes — `<tool_use_error>Shell command failed (exit code 1) ✔ mean of a list (0.378416ms) ✔ median of an odd-length list (0.09175ms) ✖ median of an even-length list averages the middle pair (0.427292ms) ℹ tests 3 ℹ suites 0 ℹ pas`
- **anchored-edit / Edit** (probe) — names a fix: yes — `<tool_use_error>Read the file before editing it — the edit needs a prior read of the current content (a Read of the lines it touches, or expected_anchor from a full Read of the file as it stands). Read ownership/coverage`
- **search-symbol / Grep** (probe) — names a fix: yes — `[openrouter] the provider emitted a malformed tool call (Grep): the arguments do not match the tool's input schema (The required parameter `pattern` is missing; The parameter `query` was not expected) — it was not execut`
- **use-skill / Skill** (probe) — names a fix: yes — `<tool_use_error>Unknown skill: provider-api. Did you mean: provider-apis? The available skills ride in system-reminder messages in this conversation.</tool_use_error>`
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
- ide-diagnostics: PASS — LSP called: true; server answered: true; first result: No diagnostics — src/stats.js is clean. [fresh report (document version 1) — pulled: mercury-ts]
- browser-page: skipped — unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent (result: skipped)
- guide-question: PASS — docs skill invoked: true; the shipped pages reached the model: true; relayed: true; no web fetch: true
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
- ide-diagnostics: PASS — LSP called: true; server answered: true; first result: No diagnostics — src/stats.js is clean. [fresh report (document version 1) — pulled: mercury-ts]
- browser-page: skipped — unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent (result: skipped)
- guide-question: PASS — docs skill invoked: true; the shipped pages reached the model: true; relayed: true; no web fetch: true
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
- ide-diagnostics: PASS — LSP called: true; server answered: true; first result: No diagnostics — src/stats.js is clean. [fresh report (document version 1) — pulled: mercury-ts]
- browser-page: skipped — unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent (result: skipped)
- guide-question: PASS — docs skill invoked: true; the shipped pages reached the model: true; relayed: true; no web fetch: true
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
- ide-diagnostics: PASS — LSP called: true; server answered: true; first result: No diagnostics — src/stats.js is clean. [fresh report (document version 1) — pulled: mercury-ts]
- browser-page: skipped — unmeasured — no browser to launch — no managed browser — your installed apps are never driven; /browser install downloads Chrome for Testing once with your consent (result: skipped)
- guide-question: PASS — docs skill invoked: true; the shipped pages reached the model: true; relayed: true; no web fetch: true
- two-seats: PASS — agent calls: 2; one parallel round: true; both seats answered with their facts: true; merged: true
- structural-rename: PASS — old name gone: true; new name in all three: true; changed: src/format.js, src/records.js, src/stats.js; README intact: true; structural apply: true; modules load (2 pass, 1 fail as before): true (2/1)
- resume-a: PASS — final: noted
- resume-b: PASS — recalled: true; resumed request carried the prior turn: true

