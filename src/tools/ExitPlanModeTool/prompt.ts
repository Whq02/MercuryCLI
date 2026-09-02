// Exit-plan doctrine + the Mercury plan-readiness appendix.
// Prover-pinned phrases: the How-This-Tool-Works heading, the readiness
// clause, 80+120 renders, EXIT CODE, the off-distribution callout, and the
// green→commit→push directive.

/** Both exported names resolve to the ONE wire name (contract data). */
export const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode'
export const EXIT_PLAN_MODE_V2_TOOL_NAME = 'ExitPlanMode'

export const EXIT_PLAN_MODE_V2_TOOL_PROMPT = `Signal that the plan is ready for the user's approval. Call it from plan mode once the plan file holds your finished plan.

## How This Tool Works
The plan is read from the plan file on disk — it is not passed as a parameter. Calling this tool signals readiness; the user reviews the file's contents and approves or rejects.

## When to use
- Only in plan mode, with the plan already written to the plan file.
- Only for planning IMPLEMENTATION work — tasks that will write code. Research or comprehension tasks end with an answer, not a plan approval.

## When NOT to use
- Unresolved requirement or approach questions belong to the question tool, in the earlier phases.
- Never use the question tool to ask whether the plan is acceptable or whether to proceed — that is exactly what THIS tool does.

## Examples
<example>"How does session restore work?" — a comprehension task: answer it directly; no plan, no exit call.</example>
<example>"Add rate limiting to the API" in plan mode — write the plan file, then call this tool for approval.</example>
<example>"Improve the build" with several plausible directions — clarify with the question tool first, plan, then call this tool.</example>

## Mercury doctrine (this harness)
a plan is ready when it names its proof: how each part will be demonstrated once built —
- terminal-UI work names its renders at the two standard widths (80+120 columns);
- code names the relevant gate subset or a proof script, read by EXIT CODE;
- work reaching the off-distribution core (the build script, identity floor and wrapper composition, capability gate and lease guard, daemon control-protocol authentication, compiled renderers) says so plainly — the operator reads those diffs before merge;
- and where the standing push-on-green directive applies, the plan names the point at which the change is committed and pushed (green→commit→push).`
