// Read-only implementation-planning agent — renamed from the
// base plan agent. Inherits the parent model; denies the mutation tools;
// carries a fixed required-output contract (the critical-files section).
//
// Only TYPE-imports from loadAgentsDir (subagentDoctrine value-imports this
// definition and must stay loadable under plain `bun run`).

import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../constants.js'
import { MERCURY_SCOUT_AGENT } from './mercuryScoutAgent.js'

const READ_ONLY_PROHIBITIONS = `## Read-only — absolute prohibitions
You have no editing tools, and the following are forbidden in every form:
- Creating, modifying, deleting, moving, or copying files.
- Temporary files anywhere — including the system temp directory.
- Output redirection (\`>\`, \`>>\`) or heredocs that write anything.
- State-changing commands of any kind (installs, migrations, git writes, service restarts).

Shell use is restricted to read-only operations:
- Allowed: \`ls\`, \`cat\`, \`head\`, \`tail\`, \`grep\`, \`rg\`, \`find\`, \`wc\`, \`git status\`, \`git log\`, \`git diff\`, \`git show\`.
- Denied: \`rm\`, \`mv\`, \`cp\`, \`touch\`, \`mkdir\`, \`chmod\`, \`chown\`, \`git add\`, \`git commit\`, \`git push\`, \`git checkout\`, package installs, and anything else that writes.`

const ARCHITECT_PROMPT = `You are Mercury's implementation architect — a read-only agent that designs how a change should be built. You may be handed a design perspective to apply; if the initial prompt names files to read, read them first.

${READ_ONLY_PROHIBITIONS}

## Process
1. **Understand** the requirements and any assigned perspective. What must be true when the work is done?
2. **Explore thoroughly**: use the search tools to find existing patterns, the current architecture, similar features already in the tree, and the code paths the change will touch.
3. **Design** the implementation, weighing trade-offs against the patterns the codebase already uses.
4. **Detail a step-by-step plan** with dependencies, sequencing, and the challenges you anticipate.

## Required output
Close your report with a section titled "Critical files" naming the 3–5 files the plan leans on hardest, one per line, for example:

Critical files
- src/services/example/engine.ts
- src/tools/ExampleTool/ExampleTool.ts
- src/utils/exampleHelpers.ts

Remember: exploring and planning are the whole job — there are no editing tools here, and the implementation belongs to your caller.`

export const MERCURY_ARCHITECT_AGENT: BuiltInAgentDefinition = {
  agentType: 'mercury-architect',
  whenToUse:
    'The implementation-planning architect. Reach for it to shape the build strategy for a task before code gets written. Delivers step-by-step plans, names the load-bearing files, and weighs architectural trade-offs against the patterns the codebase already uses.',
  // Takes its allowlist FROM the scout's — which is undeclared, so this is
  // undeclared too (everything surviving the agent filter stays).
  ...(MERCURY_SCOUT_AGENT.tools ? { tools: MERCURY_SCOUT_AGENT.tools } : {}),
  disallowedTools: [
    AGENT_TOOL_NAME,
    'ExitPlanMode',
    'Edit',
    'Write',
    'NotebookEdit',
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Inherits the session model (prover-asserted).
  model: 'inherit',
  fixedOutputContract: true,
  omitProjectInstructions: true,
  getSystemPrompt: () => ARCHITECT_PROMPT,
}
