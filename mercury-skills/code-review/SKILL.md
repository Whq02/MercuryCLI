---
name: code-review
description: Use when reviewing local changes, a commit, a branch or a pull request with parallel finders and independent verification of each finding. Not for a single frozen-worktree receipt check via Crewmate review_receipt alone, or fixing code.
argument-hint: "[target]"
---
# Code review

When no target is given, review uncommitted local changes (staged, unstaged, and untracked files) if there are any; otherwise review the current branch against its base (`@{upstream}...HEAD`, else `main...HEAD` or `master...HEAD`, else `HEAD~1..HEAD`). Leave all repository files, git refs, and the index untouched unless the user explicitly asks to apply fixes.

Every finder and verifier runs in the foreground and reports straight to the lead; the procedure is identical whether the swarm is on or off.

## 1. Parse effort, target, and conventions

Read any arguments appended after this skill:

- If the leading token is an effort level (`low`, `medium`, `high`, `xhigh`, or `max`), keep it as `<effort>`. Read `mercury://seat` with `Inspect` (`ref: "mercury://seat"`) for unspecified model and effort, honoring any explicit worker choices by the operator; on every `Crewmate` launch pass `model: "<worker_model>"` and `effort: "<effort>"`. Omission takes the agent definition or configured crewmate defaults, not the parent's effort. If no effort is set, omit it and disclose that default; if a specified effort cannot be represented by the offered schema, review directly rather than lower it.
- Treat the remaining text (or the whole argument when no effort token leads) as `<target>`: a pull request (`#123`, `123`, or PR URL), a commit SHA, a ref range (`A..B` or `A...B`), a branch name, file paths, or review instructions and exclusions. Carry any user focus or exclusion verbatim into every finder and verifier brief.
- Inspect the repository with `Git` (`op: "status"`, `op: "diff"`, `op: "show"`, `op: "mergebase"`, or `op: "reviewContext"` and `op: "prDiff"` for a pull request) and read nearby project instruction files (`MERCURY.md` or `AGENTS.md`) plus commit or PR descriptions for author intent and house rules.

## 2. Fix the review target and choose the execution road

Note the session scratchpad directory `<scratchpad>` from `<env>`, and load `Crewmate` via `ToolSearch` (`query: "select:Crewmate"`) if deferred.

Choose one of two roads from the target:

1. **Committed target (a commit, a commit range, a branch, or a pull request)**:
   - Resolve the reviewed head to a 40-character commit SHA `<head_sha>` (`git rev-parse --verify <head>^{commit}`) and record the exact diff command against its base (`git diff <base_sha> HEAD`, or `git show <head_sha>` for a standalone commit).
   - For a pull request whose head commit is absent locally, fetch it into `FETCH_HEAD` without moving any local branch (`git fetch origin pull/<n>/head`, then `git rev-parse --verify FETCH_HEAD^{commit}`). When offline or fetch is refused, save `Git` (`op: "prDiff"`, `pr: <n>`) to `<scratchpad>/pr-<n>.patch` with `Write`, set `<head_sha>` to `HEAD`, and note in briefs where `HEAD` differs from the pull request.
   - Launch every finder and verifier in **review mode**: `Crewmate` with `crewmate_type: "mercury-crew"`, `isolation: "worktree"`, `worktree_at: "<head_sha>"`, and `review_receipt: "<scratchpad>/<seat>.md"`, omitting `cwd` (`review_receipt` refuses calls that set `cwd`, omit `isolation: "worktree"` or `worktree_at`, name a missing or non-`.md` file, or place the receipt inside the worktree).
2. **Uncommitted local changes (staged, unstaged, or untracked edits in the working tree)**:
   - Never commit onto the user's branch to mint a SHA, and never detach a worktree at `HEAD` to review dirty edits (a detached `HEAD` worktree holds pre-edit lines and checks the wrong tree).
   - Save the staged and unstaged diffs (`Git` with `op: "diff"`, `scope: "staged"` and `scope: "worktree"`) plus the list of untracked files (`Git` with `op: "status"`) to `<scratchpad>/review-uncommitted.patch` using `Write`.
   - Launch every finder and verifier with `crewmate_type: "mercury-scout"` (omitting `isolation`, `worktree_at`, and `review_receipt`) and `output_schema` (`{ "type": "object", "required": ["candidates"], "properties": { "candidates": { "type": "array", "items": { "type": "object", "required": ["file", "summary", "failureScenario", "proposedFix"], "properties": { "file": { "type": "string" }, "line": { "type": "integer" }, "summary": { "type": "string" }, "failureScenario": { "type": "string" }, "proposedFix": { "type": "string" } } } } } }` for finders; `{ "type": "object", "required": ["rulings"], "properties": { "rulings": { "type": "array", "items": { "type": "object", "required": ["id", "file", "verdict", "evidence"], "properties": { "id": { "type": "integer" }, "file": { "type": "string" }, "line": { "type": "integer" }, "verdict": { "enum": ["CONFIRMED", "REFUTED", "UNPROVEN"] }, "evidence": { "type": "string" }, "proposedFix": { "type": "string" } } } } } }` for verifiers), so seats read the live working-tree files at their real post-edit line numbers while `mercury-scout` refuses every write, edit, or state-changing shell command.

When the diff and untracked file list in scope are empty, report that nothing changed and stop without launching crewmates.

## 3. Launch parallel finders in one message

Split review coverage across concurrent foreground finders (`run_in_background` omitted):

- **Small or medium diff (up to ~300 changed lines)**: launch **3 finders** in **one message**, each covering the diff through a distinct lens:
  1. `finder-logic` — hunk-by-hunk logic and boundaries: read each hunk and `Read` its whole enclosing function (defects on untouched lines of a touched function are in scope when exposed by the change); check inverted or misaimed conditions, off-by-one bounds, null/undefined/falsy-zero handling, type/coercion traps, unescaped regex/shell/SQL inputs, resource leaks, and dropped or swallowed error paths.
  2. `finder-state` — state, ordering, concurrency, and races: trace shared mutable state, async interleavings across `await`, callbacks, timers, streams, or child processes, check-then-act gaps, shrunk or missing lock/lease/transaction scopes, stale reads or mutated collections across yields, retry/idempotency hazards, and partial-failure or cancellation cleanup.
  3. `finder-contracts` — callers, callees, lost guards, and conventions: `Grep` callers of every changed function, method, or export and test them against new preconditions, return shapes, or throws; check every removed or rewritten line to verify where the guard or invariant it enforced now lives; check `MERCURY.md`/`AGENTS.md` conventions, duplicate helpers, and hot-path waste.
- **Large diff (>300 changed lines, or `xhigh`/`max`)**: launch **4 or 5 finders** in **one message**, partitioning file-heavy hunks by directory or subsystem while keeping `finder-state` and `finder-contracts` across cross-file boundaries.

On the committed road, before calling `Crewmate`, create one receipt file per finder with `Write` at `<scratchpad>/<seat>.md` containing the review context block and ending with `\n## Review\n`.

### Finder brief

```text
Review target: <target description>
Diff source: <`git diff <base_sha> HEAD` in your frozen worktree | `<scratchpad>/review-uncommitted.patch` against the live checkout>
Changed files: <repo-relative file list>
Author intent: <one-paragraph summary>
Project conventions: <relevant MERCURY.md / AGENTS.md rules, or "none noted">
User instructions / exclusions (override default lens breadth): <verbatim user instructions, or "none">

Your lens: <lens name and instructions>

1. Read the diff first, then `Read` the complete enclosing functions and surrounding invariants of touched hunks, and `Grep` callers or callees where contracts move. On a frozen worktree (`review_receipt`), run confined verification (`bun run typecheck`, `bun scripts/<file>.ts`, or `bash scripts/<file>.sh`) when matching checks exist; note that review confinement refuses other non-read-only commands.
2. Skip pure formatting, linter-owned style, naming taste, speculative hypotheticals untied to the diff, and anything excluded by user instructions.
3. For each candidate defect, record:
   - `file` and 1-based `line` (or `Lstart-Lend`)
   - one-sentence defect claim
   - concrete failure scenario (exact inputs, state, or step-by-step async/concurrent interleaving and observable bad result)
   - minimal proposed fix
4. Output:
   - Frozen worktree road (`review_receipt` `<scratchpad>/<seat>.md`): write findings only via `Edit` (`file_path: "<scratchpad>/<seat>.md"`, `section: "## Review"`, `append: "<bullet list using - or ### headings only; never include # or ## headings>"`, or `- Clean — no defects found in this lens.`), then summarize and end your final message with `REVIEW: CLEAN` or `REVIEW: FINDINGS <count>` and nothing after it.
   - Uncommitted `mercury-scout` road: return `{ "candidates": [{ "file": "...", "line": 1, "summary": "...", "failureScenario": "...", "proposedFix": "..." }] }` via `StructuredOutput`.
```

## 4. Test every candidate on another model family

1. Read every finder's output (and `Read` each `<scratchpad>/finder-*.md` receipt on the committed road). When all finders return zero candidates, inspect the diff yourself once to confirm nothing material was missed and report a clean review.
2. Deduplicate candidates that share the same root cause and location, preserving the clearest failure scenario and noting how many finders flagged each candidate.
3. Read `mercury://models` via `Inspect` (`ref: "mercury://models"`) or `Read` (`file_path: "mercury://models"`) and, unless the operator fixed the verifier's identity, pick a reachable model from **another model family** than the finders' model (`<verifier_model>`), keeping `<effort>`. Compare model families, not hosting providers. When no second family is reachable, keep `<worker_model>` and state single-family verification plainly in the report.
4. Group candidates into batches of up to 5 per verifier (1 verifier for 1 to 5 candidates; 2 or 3 concurrent verifiers in **one message** for larger sets). On the committed road, `Write` `<scratchpad>/verifier-<k>.md` ending with `\n## Review\n` before launching.
5. Launch all verifier seat(s) concurrently in **one message** (foreground; `model: "<verifier_model>"` when signed in; same `isolation: "worktree"`, `worktree_at: "<head_sha>"`, `review_receipt: "<scratchpad>/verifier-<k>.md"` without `cwd` on the committed road, or `crewmate_type: "mercury-scout"` with `output_schema` on the uncommitted road).

### Verifier brief

```text
You are testing candidate review findings against the code. Try to knock each candidate down with repository evidence, while keeping every real defect — especially concurrency races and reachable edge paths.

Review context: <same target, diff source, files, intent, conventions, and user instructions>
Candidates to test:
<#1 file:line — claim — predicted failure scenario — proposed fix>
...

For each candidate, inspect the diff, `Read` the full involved functions, types, locks, and callers, run confined `bun run typecheck` or `scripts/` checks when available on a frozen worktree, and assign one verdict with quoted file and line evidence:

- `CONFIRMED` — quote the exact lines and trace the concrete inputs, state, or step-by-step async/concurrent interleaving that causes the crash, wrong output, lost update, or broken invariant. When two operations, turns, callbacks, timers, or I/O completions can interleave across an `await` or non-atomic gap without a lock, transaction, or guard holding them apart, rule `CONFIRMED` (or `UNPROVEN` when reachability depends on external wiring outside the repository). Never rule a realistic race, partial failure, falsy-zero, or rare error path `REFUTED` merely because timing is nondeterministic.
- `REFUTED` — rule `REFUTED` only from code proof: quote the exact guard, lock, type constraint, synchronous turn without yields, or invariant that makes the scenario unreachable, or show that the candidate has no observable behavioral or maintenance cost.
- `UNPROVEN` — the mechanism in the changed code is real, but repository files alone do not settle whether callers or runtime configuration can trigger it; state what check or fact settles it.

Output:
- Frozen worktree road (`review_receipt` `<scratchpad>/verifier-<k>.md`): record every ruling via `Edit` (`file_path: "<scratchpad>/verifier-<k>.md"`, `section: "## Review"`, `append: "<one ### or - entry per candidate with verdict, quoted evidence, and fix; never include # or ## headings>"`), then end your final message with `REVIEW: CLEAN` (when zero candidates are `CONFIRMED` or `UNPROVEN`) or `REVIEW: FINDINGS <confirmed_plus_unproven_count>` and nothing after it.
- Uncommitted `mercury-scout` road: return `{ "rulings": [{ "id": 1, "file": "...", "line": 1, "verdict": "CONFIRMED", "evidence": "...", "proposedFix": "..." }] }` via `StructuredOutput` (`verdict` in `["CONFIRMED", "REFUTED", "UNPROVEN"]`).
```

## 5. Report to the user

Read every verifier's rulings (`<scratchpad>/verifier-*.md` on the committed road). Drop `REFUTED` candidates from findings. Order `CONFIRMED` findings worst-first (data loss, security, concurrency races, and crashes first; then functional bugs; then convention, reuse, or efficiency issues — correctness ahead of quality).

Structure the report:

- **Scope and checks**: reviewed target/SHA/files, verification commands run, and finder vs verifier model families (noting plainly when only one model family was signed in).
- **Confirmed findings** (numbered, worst-first): `file:line`, severity (`blocker`, `major`, `minor`), defect and concrete failure or race interleaving, verifier evidence, and proposed fix. State clearly when no findings survived.
- **Unproven leads** (separate section when any remain): `file:line`, mechanism, and what settles it.
- **Not reviewed**: untracked external callers, test suites not runnable under review-mode confinement, or excluded paths.
