import {
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../../utils/envUtils.js'
import { searchToolsAvailability } from '../../utils/ripgrep.js'
import { CREWMATE_BARRED_TOOLS } from '../../constants/tools.js'
import { AGENT_TOOL_NAME, MERCURY_CREW_AGENT_TYPE, MERCURY_SCOUT_AGENT_TYPE } from './constants.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { SCOUT_TOOLS_DESCRIPTION } from './scoutPolicy.js'

function describeTools(agent: AgentDefinition): string {
  if (agent.source === 'built-in' && agent.agentType === MERCURY_SCOUT_AGENT_TYPE) return SCOUT_TOOLS_DESCRIPTION
  const allow = agent.tools
  const deny = agent.disallowedTools
  const hasAllow = Array.isArray(allow) && allow.length > 0
  const hasDeny = Array.isArray(deny) && deny.length > 0
  if (hasAllow && hasDeny) {
    const effective = allow!.filter(name => !deny!.includes(name))
    return effective.length > 0 ? effective.join(', ') : 'None'
  }
  if (hasAllow) return allow!.join(', ')
  if (hasDeny) return `All tools except ${deny!.join(', ')}`
  return 'All tools'
}

function formatAgentLine(agent: AgentDefinition, refusal?: string): string {
  const line = `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${describeTools(agent)})`
  return refusal === undefined ? line : `${line} — ${refusal}`
}

function fileLocationHint(): string {
  return searchToolsAvailability().available
    ? 'the Glob tool'
    : 'shell `find`'
}

function contentSearchHint(): string {
  return searchToolsAvailability().available
    ? 'the Grep tool'
    : 'shell `grep` (a name-only find does not look at contents)'
}

function crewmateToolboxNote(offered?: ReadonlySet<string>): string {
  const barred = Object.keys(CREWMATE_BARRED_TOOLS).filter(name => name !== AGENT_TOOL_NAME && (offered === undefined || offered.has(name)))
  const except = barred.length > 0 ? `${barred.join(', ')} and the ${AGENT_TOOL_NAME} tool itself` : `the ${AGENT_TOOL_NAME} tool itself`
  return `A crewmate carries every tool of this session except ${except} — the few that need the operator present or reach past its own work — in the foreground and in the background alike; the processes it starts (background shells, code kernels, the services it starts for the session, debug sessions, its browser) end when it ends.`
}

export async function getPrompt(
  agentDefinitions: readonly AgentDefinition[],
  isCoordinator = false,
  allowedAgentTypes?: readonly string[],
  offered?: ReadonlySet<string>,
  refusals?: ReadonlyMap<string, string>,
): Promise<string> {
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(agent =>
        allowedAgentTypes.includes(agent.agentType),
      )
    : agentDefinitions

  const listing = effectiveAgents.map(agent => formatAgentLine(agent, refusals?.get(agent.agentType))).join('\n')

  const typeSelection = `Specify \`crewmate_type\` to select an agent; omitting it gives ${MERCURY_CREW_AGENT_TYPE}.`

  const core = `Launch a crewmate to work through a complicated, multi-step job on its own. The available agents are specialised — each has its own capabilities and tool access:

${listing}

${typeSelection}`

  if (isCoordinator) return core

  const sections: string[] = [core]

  sections.push(`## When delegating is the wrong move
- Reading a known path — the direct read tool resolves faster.
- Finding a specific class or symbol definition — use ${fileLocationHint()} directly.
- Searching within 2–3 known files — use ${contentSearchHint()} directly.
- Tasks unrelated to the agent descriptions above.`)

  const usage: string[] = [
    'When several crewmates can run at once, launch them all in one message — one tool-use block each — so they overlap rather than queue; separate messages run serially.',
    "The crewmate returns a single message that the user cannot see — relay a concise summary of its result.",
    'With `run_in_background: true` the crewmate runs detached: completion returns to you as a notification — never sleep, poll, or proactively check on it. Run in the background when the work is long and independent; run in the foreground when your next step depends on the report.',
    crewmateToolboxNote(offered),
    "Treat the crewmate's prose as a claim to verify, not a fact: spot-check load-bearing results with a diff, a render, or a test before relying on them. A status=\"valid\" payload passed your schema: use it without re-reading what the crewmate read, and require evidence as a field when a value needs it.",
    "State explicitly whether the crewmate should write code or only research — it cannot see the user's intent.",
    'When an agent description says to use it proactively, honour that cue without waiting to be asked.',
    "Passing `isolation: \"worktree\"` hands the crewmate a temporary git worktree of its own. It requires a git repository (or a configured worktree-create hook); outside one, omit the parameter. Nothing is removed automatically: the worktree survives the crewmate's end unlocked, its path and branch riding back in the result with what it holds, and the seven-day janitor removes only a clean one whose commits are reachable.",
  ]
  sections.push(`## Usage notes
${usage.map(note => `- ${note}`).join('\n')}`)

  sections.push(`## Writing the prompt
The briefing should read as one written for a capable colleague arriving cold: they have not followed the conversation, do not know what was already tried, and do not know why the task matters. State the objective and the reason for it, what has already been established or eliminated, and enough surrounding situation that the crewmate can exercise judgment instead of following a narrow instruction. Ask for a short answer explicitly when one is wanted. For a lookup, supply the exact command; for an investigation, supply the question itself — a fixed procedure becomes useless the moment its premise turns out wrong. Clipped, imperative prompts yield shallow generic work.

Implementation briefs carry the known target and acceptance criteria. Investigation briefs carry the unresolved question, evidence already checked, boundaries and required evidence in the answer. Keep ownership of the overall task; delegate reasoning inside a well-scoped question.`)

  return sections.join('\n\n')
}
