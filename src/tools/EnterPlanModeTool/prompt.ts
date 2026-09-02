// When-to-plan doctrine. Mercury layer: the repo-specific
// plan-quality appendix (prover-pinned headings and phrases).

import { isAutopilotEnabled } from '../../utils/autopilot/autopilotGates.js'

export const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode'

const BASE_PROMPT = `Reach for this tool only under genuine ambiguity: the right way to do the task is unsettled, and hearing from the user before writing code would save substantial rework. Calling it moves the session into plan mode.

## When to Use This Tool
- **Significant architectural ambiguity** — several reasonable approaches differ meaningfully. <example>Adding real-time sync where either polling or a websocket channel would work, with different infra costs.</example> <example>Introducing caching where the layer (client, server, storage) changes the invalidation story.</example>
- **Unclear requirements needing exploration first** — the request cannot be pinned down without reading the code. <example>"Make startup faster" with no profile in hand.</example> <example>"Clean up the auth flow" in a codebase with three auth entry points.</example>
- **High-impact restructuring where buy-in reduces risk** — the change touches many callers or a public contract. <example>Splitting a monolithic service module used across the tree.</example> <example>Changing a persistence format existing sessions replay.</example>

## When NOT to enter plan mode
- The approach is inferable from the code or the request.
- The task is straightforward, even when it spans many files.
- The request is specific enough to start.
- An obvious implementation pattern in the repository applies.
- A bug fix whose fix is clear once the bug is understood.
- Research or exploration — delegate that instead.
- The user's phrasing signals "let's just start".

Tie-breaker: prefer starting work and using AskUserQuestion for the specific decisions that surface, over a full planning phase.

## What happens in plan mode
The session stops writing and only reads: explore the codebase, weigh approaches, and write the plan. Exiting goes through the plan-approval tool.

## Examples
<good-example>A feature that could live in the daemon or the client, with different failure modes — plan first.</good-example>
<bad-example>Renaming a function and its call sites — just do it.</bad-example>

Note: this tool REQUIRES user approval before the session enters plan mode.`

const MERCURY_DOCTRINE = `## Mercury doctrine (this harness)
- A plan that reaches terminal-UI surfaces states how the rendering will be checked: the repository's render script (\`bun run scripts/ui/render_tui.ts --scenario <s>\`) at the two standard widths (80+120 columns) — a claim about layout is settled by looking at a render, never by reading source.
- A plan that lands code states what will demonstrate it: the relevant subset of the all-suites gate script judged by its EXIT CODE, or the particular proof script that pins the change.
- A plan that reaches the off-distribution core (the build script, the identity floor and wrapper composition, the capability gate and lease guard, daemon control-protocol authentication, compiled renderers) says so plainly: those get an operator diff-read before merge and are preferably hand-coded rather than delegated.`

const AUTOPILOT_APPENDIX = `
- Under the autopilot family, plan entry raises reasoning effort to the planning tier; after approval, mechanical execution may downshift via SetTier.`

export function getEnterPlanModeToolPrompt(): string {
  return `${BASE_PROMPT}

${MERCURY_DOCTRINE}${isAutopilotEnabled() ? AUTOPILOT_APPENDIX : ''}`
}
