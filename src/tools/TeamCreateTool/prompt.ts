import { displayConfigHome } from '../../utils/envUtils.js'
import { MERCURY_PROJECT_DIR } from '../../utils/projectConfig.js'
import type { AgentDefinition } from '../AgentTool/loadAgentsDir.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'

const WRITE_TOOL_NAMES = [
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]

/** First sentence (or 140 chars) of a mission string — roster lines stay scannable. */
function missionSummary(whenToUse: string): string {
  const firstSentence = whenToUse.split(/(?<=[.!?])\s/)[0] ?? whenToUse
  return firstSentence.length > 140
    ? `${firstSentence.slice(0, 137)}…`
    : firstSentence
}

/** 'read-only' when the definition's tool contract carries no write tool. */
function capabilityOf(def: AgentDefinition): 'read-only' | 'full-capability' {
  if (!def.tools || def.tools.includes('*')) return 'full-capability'
  return def.tools.some(t => WRITE_TOOL_NAMES.includes(t))
    ? 'full-capability'
    : 'read-only'
}

/** The roster section, GENERATED from the live agent registry so the guidance
 *  can never drift from what is actually spawnable. */
function rosterSection(agents: AgentDefinition[]): string {
  if (agents.length === 0) {
    return 'No agent roles are registered right now — spawn general teammates by name only.'
  }
  return agents
    .map(a => `- **${a.agentType}** (${capabilityOf(a)}) — ${missionSummary(a.whenToUse)}`)
    .join('\n')
}

export function getPrompt(agents: AgentDefinition[] = []): string {
  return `
# TeamCreate

Create a CHARTERED Mercury team: a named group of agents with a shared objective, explicit success criteria, a synthesis owner, and a shared task list (Team = TaskList = 1:1).

## When to use a team — and when not to

Create a team ONLY when at least one of these holds:
- The user explicitly asked for a team, swarm, or multiple agents working together.
- The work has TWO OR MORE genuinely independent lanes — separable by ownership (different files, subsystems, or deliverables) that can proceed in parallel without serializing on each other.

Otherwise stay a single agent. Small tasks, serial pipelines (A must finish before B can start), and single-surface work are faster and clearer without a team. Do not create a team "just in case".

## Charter before spawn

State the team's intent in the tool call:

\`\`\`
{
  "team_name": "checkout-refactor",
  "objective": "Split checkout into cart/payment services with tests green",
  "success_criteria": ["payment service passes its suite", "cart no longer imports payment internals"]
}
\`\`\`

Before spawning teammates you (the lead) must be able to name: the synthesis owner (you — teammates report conclusions and evidence to you, never raw transcripts), and for EACH teammate an owned surface plus a concrete deliverable. Decompose by ownership and deliverable, not by vague job titles.

The call writes the team file to \`${displayConfigHome()}/teams/{team-name}/config.json\` (with the versioned charter) and a task list at \`${displayConfigHome()}/tasks/{team-name}/\`. Creation is atomic: on failure nothing is left behind.

## Choosing teammate roles (the live Mercury roster)

Pick each teammate's \`subagent_type\` by the tool contract its lane needs — read-only roles map evidence and design; only full-capability roles change files. Never assign implementation to a read-only role.

${rosterSection(agents)}

Custom roles defined in \`${MERCURY_PROJECT_DIR}/agents/\` can ship with their own tool restrictions — read their descriptions.

## Team workflow

1. **TeamCreate** (this tool) — creates the team, its charter, and its task list
2. **TaskCreate** one task per work lane; wire dependencies with \`addBlockedBy\`
3. **Spawn teammates** via the Agent tool with \`team_name\` and \`name\` (+ the role's \`subagent_type\`)
4. **Assign work** with TaskUpdate \`owner\` — or let teammates claim unowned, unblocked tasks themselves
5. **Teammates deliver handoffs** (outcome · owned surface · evidence · decisions · blockers · next) and mark tasks completed
6. **You synthesize** — fold conclusions and evidence into the deliverable, linking changed files and proof results
7. **Shutdown** — SendMessage \`{type: "shutdown_request"}\` to each teammate, then TeamDelete

## Communication and state (keep the transcript calm)

- Messages from teammates are delivered to you AUTOMATICALLY as conversation turns — never poll an inbox and never ask teammates to re-send.
- Teammates go idle between turns; idle means WAITING (ready for more work), not stuck or done. Wake one by sending it a message. Don't comment on idleness unless it actually blocks you.
- Peer-DM summaries ride idle notifications for visibility — informational, no response needed.
- Use the STRUCTURED state you already have: TaskList is the shared board, and the roster arrives with your team context. Do not re-read team/task files each turn. (Only pane-backed teammates without tool access fall back to reading \`${displayConfigHome()}/teams/{team-name}/config.json\`.)
- Refer to teammates by NAME (for SendMessage \`to\` and task \`owner\`); agent ids are for reference only.
- Communicate in plain text — no JSON status blobs; idle notifications travel from the system, never from you.
- Task ownership: TaskUpdate lets any agent take or hand it over; with several open, take them in ID order.

`.trim()
}
