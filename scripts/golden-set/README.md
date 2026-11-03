# Task-completion golden set

Ten small end-to-end tasks measure completion, not whether a model says it followed a tool preference. The task prompts in `tasks.ts` are ordinary user requests and contain no tool hints. Each task names the sentence under test. The fixture has two callers of `parseRow`, a constant shared by two source files, a deliberately misspelled utility name, a two-page text PDF, a passing test, and bounded-output/hanging shell scripts.

## Run on a tree in one command

From the checkout containing this eval, with Bun, Node 24, git, dependencies, and the project's vendor packs installed:

```sh
H=$(mktemp -d) && env -u MERCURY_HOME -u MERCURY_CRITTER TMPDIR=/private/tmp/mw MERCURY_CONFIG_DIR="$H" node scripts/golden-set/drive-golden-set.ts --home "$H" --tree "$PWD" --model local/qwen3.5:9b --runs 2 --output "$PWD/scripts/golden-set/results/before"
```

`--tree` selects the Mercury checkout to build and run; it may differ from the checkout holding this eval. Omit it to test this checkout. The default model is `local/qwen3.5:9b`; repeat `--model` to name another model explicitly. Read `mercury://models` before choosing live model IDs. Node 24 hosts the drive and its headless children; Bun builds the artifact and runs the fixture test. The build and every child run have scratch homes. `MERCURY_HOME` is removed from each child environment and `TMPDIR` is `/private/tmp/mw`. This driver never reads, copies, or seeds credential files.

Each row gets a fresh fixture and a distinct config directory under `--home`. The driver rejects homes under the owner's home or checkout. It creates only onboarding settings, not credentials. A local run needs no account state. For a credentialed road, the lead must arrange the account through Mercury's sign-in surfaces in the row's config directory; this seat does not provision it. Row directory names are `<task>-<sanitized-model>-run<N>-config`. Supplied existing config directories are preserved; newly created config directories and fixture copies are deleted after the final state is judged.

The default limits are eight model turns, 150 seconds, and $0.75 per run, with effort `low`. `--max-turns`, `--max-time`, and `--budget` override those bounds. A driver process-group kill at the time limit plus 30 seconds is a last-resort harness guard, not a model tool call. `--jobs 1` is the default; local readings stay serial to avoid two local generations contending for the same server. A failed run is one measured row, never a reason to retry it.

Use `--tasks T2,T8` for a subset and `--run 2` to select one repetition. `--runs 2` selects repetitions 1 and 2 by default. `--skip-build` reuses the existing bundle only when the caller has established its provenance. The recorded bundle hash makes that choice inspectable. `--markdown <path>` writes the final table to an additional, explicitly supplied path. `--defer-model claude-opus-5-5` adds clearly unmeasured rows labeled **lead runs from the main loop**; their metrics are null, not zero.

## Evidence and resumption

The output directory holds `results.json`, the generated `baseline.md`, streamed JSON-line transcripts, stderr, a result file and final-fixture hash evidence for every run, and `self-check.json`. These are ignored by git. Keep this directory with the baseline so every flipped row still has its transcript. The commit, source-tree object, bundle hash, fixture hash, task hash, model, and limits are recorded.

Re-run the same command with the same `--output` to resume. All settled measured rows, including failures, are skipped. A row that started but was interrupted is retained as a failed interrupted attempt, not silently retried. If its child is still alive, resumption refuses until that bounded process ends. Changing the commit, bundle, fixture, task definitions, or limits requires a new output directory. An unmeasured deferred row can be replaced by an actual run of that same model/task/repetition. There is no credential copying during resumption.

## Judge and red-to-green check

```sh
H=$(mktemp -d) && env -u MERCURY_HOME TMPDIR=/private/tmp/mw MERCURY_CONFIG_DIR="$H" node scripts/golden-set/drive-golden-set.ts --home "$H" --self-check
```

The self-check accepts a correct example and rejects a sabotage for every task. In particular, an unchanged greeting fails T2 even when the answer says “Done”; this proves that completion is not a transcript-word check. A watchdog fails T1 despite a correct line-count answer, an unsolicited Markdown file fails T8, and curl is counted separately from T6's correct title answer. The same check runs before every paid or local drive.

`judge.ts` contains the deterministic rubric. It hashes the whole final fixture, checks the exact permitted edits, executes `bun test.ts` after the two-file rename, checks the answer's counts/files/headings/title/final line, and verifies that ToolSearch admitted ContextLeft before a measured remaining-token answer. T1/T9 also require an observed invocation of their scripts. No model judge is used: this set has no unconstrained prose answer that needs one. Exact-edit tasks intentionally reject unrelated formatting changes.

Completion and tool choice are separate. The named wrong-tool list records shell cat/sed file-work bypasses, watchdog loops/scripts, separate Edit calls for T3, Bash curl/wget for T6, and an unsolicited Markdown Write for T8. T1's no-watchdog rule and T7's admission requirement are also completion conditions. T3 records the tools used for the rename. Total calls count dispatched `tool_call` rows; canonical identical tool/argument pairs after their first occurrence count as repeated calls. Tokens come from outcome usage (or observed step usage for an interrupted run), not estimates from transcript length. Wrong-tool detection is a named syntactic list, not a universal semantic classifier; inspect the linked call if it matters.

## Compare two baselines

```sh
node scripts/golden-set/drive-golden-set.ts --compare scripts/golden-set/results/before/results.json scripts/golden-set/results/after/results.json
```

The comparison lists **each task/model/repetition that flipped** and both transcript paths, not a single aggregate score. It refuses differing fixture or task hashes, and names unmatched rows. Examine the flipped transcripts and per-task metrics before deciding whether to keep a tool-text change. Two repeats are a small sample, not a causal ablation or a confidence interval.
