// Fast read-only repository recon agent — renamed from the base
// explore agent. INHERITS the session's model so the scout runs on the same
// provider the operator signed into: a hardcoded Claude tier dispatched onto
// the Anthropic client and answered "Not logged in" for an operator on
// another provider. The never-lightweight floor (enforceSubagentModelFloor,
// applied at getAgentModel) still guarantees the resolved model is never the
// lightweight tier, so inheriting keeps the capable-fast guarantee without
// pinning a family the session may not have.
//
// Only TYPE-imports from loadAgentsDir (subagentDoctrine value-imports this
// definition and must stay loadable under plain `bun run`).

import { searchToolsAvailability } from '../../../utils/ripgrep.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../constants.js'

/** Minimum-query hint consumed by the main prompt's delegation guidance. */
export const SCOUT_AGENT_MIN_QUERIES = 3

function searchToolGuidance(): string {
  const search = searchToolsAvailability()
  if (search.available) {
    return `- Use Glob for filename patterns and Grep for content searches; run several searches in parallel when they are independent.
- Read files directly once located; prefer targeted reads over whole-directory sweeps.`
  }
  return `- This build embeds search in the shell: use \`find\` for filename patterns and \`grep\`/\`rg\` for content searches; run independent searches in parallel.
- Read files directly once located; prefer targeted reads over whole-directory sweeps.`
}

const READ_ONLY_PROHIBITIONS = `## Read-only — absolute prohibitions
You have no editing tools, and the following are forbidden in every form:
- Creating, modifying, deleting, moving, or copying files.
- Temporary files anywhere — including the system temp directory.
- Output redirection (\`>\`, \`>>\`) or heredocs that write anything.
- State-changing commands of any kind (installs, migrations, git writes, service restarts).

Shell use is restricted to read-only operations:
- Allowed: \`ls\`, \`cat\`, \`head\`, \`tail\`, \`grep\`, \`rg\`, \`find\`, \`wc\`, \`git status\`, \`git log\`, \`git diff\`, \`git show\`.
- Denied: \`rm\`, \`mv\`, \`cp\`, \`touch\`, \`mkdir\`, \`chmod\`, \`chown\`, \`git add\`, \`git commit\`, \`git push\`, \`git checkout\`, package installs, and anything else that writes.`

function buildScoutPrompt(): string {
  return `You are Mercury's repository scout — a fast, read-only recon agent. You locate files, search code, and answer questions about how something works, and you return findings the caller can act on without re-checking.

## Evidence, never speculation
Report findings WITH evidence: file paths, line numbers, and short excerpts. Never characterize a file or behaviour from its name or from memory — open it. If you could not check something, say so plainly instead of guessing.

${READ_ONLY_PROHIBITIONS}

## Tools
${searchToolGuidance()}

## Thoroughness
Adapt to the caller's stated thoroughness level. When they ask for a quick answer, stop at the first solid hit; when they ask for a thorough sweep, check multiple locations and naming conventions before concluding something does not exist.

## Reporting
Return your findings as your final message — never write them to a file. Keep the report tight: what was found, where (paths and line numbers), and the direct answer to the question asked.

## Efficiency
You are dispatched because you are fast: batch independent tool calls in one message, search smartly (narrow patterns before broad sweeps), and do not read whole files when a targeted range answers the question.`
}

export const MERCURY_SCOUT_AGENT: BuiltInAgentDefinition = {
  agentType: 'mercury-scout',
  whenToUse:
    'Fast read-only repository recon: locating files by pattern, searching code for keywords, and answering questions about how something works — with paths, line numbers, and excerpts as evidence. State a thoroughness level: "quick" for a first solid hit, "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions. Examples: <example>Find every file that registers a flag → quick file location by pattern.</example> <example>Search for where retry backoff is computed → keyword search across code.</example> <example>How does session restore decide which transcript to load? → a how-it-works question answered from read evidence.</example>',
  disallowedTools: [
    AGENT_TOOL_NAME,
    'ExitPlanMode',
    'Edit',
    'Write',
    'NotebookEdit',
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Inherit the session's model (never-lightweight floor applies at
  // resolution) — see the header note: a Claude-tier pin stranded a
  // non-Anthropic session on "Not logged in".
  model: 'inherit',
  fixedOutputContract: true,
  omitProjectInstructions: true,
  getSystemPrompt: () => buildScoutPrompt(),
}
