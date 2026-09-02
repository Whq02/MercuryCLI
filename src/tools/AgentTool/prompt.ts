// The Agent tool's model-facing description text and per-agent listing
// lines. Mercury layers: the verify-the-claim clause and the
// worktree parameter guidance.
//
// The listing line shape is FORMAT CONTRACT DATA: the same builder emits it
// into the attachment path, and the two must stay byte-identical.

import { isProSubscriber } from '../../utils/auth.js'
import {
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../../utils/envUtils.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { isInProcessTeammate } from '../../utils/teammateContext.js'
import { isTeammate } from '../../utils/teammate.js'
import { searchToolsAvailability } from '../../utils/ripgrep.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/constants.js'
import { AGENT_TOOL_NAME } from './constants.js'
import { isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/** The attachment-listing feature gate (remote key spelling — contract
 *  data, lead-pinned). */
const AGENT_LIST_ATTACH_GATE = 'mercury_agent_list_attach'

/**
 * Describe an agent's tool access for the listing line. Both branches test
 * for a NON-EMPTY array — a definition declaring `tools: []` is described
 * as having all tools while its resolved pool is empty. That divergence is
 * the source's behaviour (check 44): the listing bytes are what the
 * prompt cache and the attachment path are pinned against.
 */
function describeTools(agent: AgentDefinition): string {
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

/** One listing line — consumed by the inline block AND the attachment path
 *  (byte-identical by construction). */
export function formatAgentLine(agent: AgentDefinition): string {
  return `- ${agent.agentType}: ${agent.whenToUse} (Tools: ${describeTools(agent)})`
}

/**
 * Whether the agent list rides system-reminder attachments instead of the
 * tool description: the feature gate decides (default off; the compat env
 * override is retired). The attachment mode exists
 * because a dynamic list inside the tool
 * description busts the whole tool-schema prompt cache whenever MCP
 * connects, extensions reload, or permission modes change.
 */
export function shouldInjectAgentListInMessages(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE(AGENT_LIST_ATTACH_GATE, false)
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

/**
 * The composed Agent tool prompt. Coordinator mode returns only the
 * shared core; the non-coordinator prompt appends the when-not-to-use,
 * usage-notes, fork, prompt-writing, and example sections per gate.
 */
export async function getPrompt(
  agentDefinitions: readonly AgentDefinition[],
  isCoordinator = false,
  allowedAgentTypes?: readonly string[],
): Promise<string> {
  const forkOn = isForkSubagentEnabled()
  const attachListing = shouldInjectAgentListInMessages()
  const effectiveAgents = allowedAgentTypes
    ? agentDefinitions.filter(agent =>
        allowedAgentTypes.includes(agent.agentType),
      )
    : agentDefinitions

  const listing = attachListing
    ? 'The roster of agent types arrives in system-reminder messages in this conversation.'
    : effectiveAgents.map(formatAgentLine).join('\n')

  const typeSelection = forkOn
    ? 'Specify `subagent_type` for a specialist, or omit it to fork yourself — the fork inherits your full conversation context.'
    : 'Specify `subagent_type` to select an agent; omitting it gives the general-purpose agent.'

  const core = `Launch a new agent to work through a complicated, multi-step job on its own. The available agents are specialised — each has its own capabilities and tool access:

${listing}

${typeSelection}`

  if (isCoordinator) return core

  const sections: string[] = [core]

  if (!forkOn) {
    sections.push(`## When delegating is the wrong move
- Reading a known path — the direct read tool resolves faster.
- Finding a specific class or symbol definition — use ${fileLocationHint()} directly.
- Searching within 2–3 known files — use ${contentSearchHint()} directly.
- Tasks unrelated to the agent descriptions above.`)
  }

  // Always true: the compat background-tasks env kill is retired.
  const backgroundEnabled = true
  const inProcess = isInProcessTeammate()
  const usage: string[] = [
    'Always include a short (3–5 word) `description` of the task.',
  ]
  if (!isProSubscriber() && !attachListing) {
    usage.push(
      'When several agents can run at once, launch them all in a single message so they overlap rather than queue.',
    )
  }
  usage.push(
    "The agent returns a single message that the user cannot see — relay a concise summary of its result.",
  )
  if (backgroundEnabled && !inProcess && !forkOn) {
    usage.push(
      'With `run_in_background: true` the agent runs detached: completion returns to you as a notification — never sleep, poll, or proactively check on it. Run in the background when the work is long and independent; run in the foreground when your next step depends on the report.',
    )
  }
  usage.push(
    `To pick an earlier spawned agent back up, address ${SEND_MESSAGE_TOOL_NAME} to its id or name — it resumes with its full context intact. Each fresh ${AGENT_TOOL_NAME} invocation otherwise starts without context.`,
    "Treat the agent's output as a claim to verify, not a fact: spot-check load-bearing results with a diff, a render, or a test before relying on them.",
    `State explicitly whether the agent should write code or only research${forkOn ? '' : ' — it cannot see the user\'s intent'}.`,
    'When an agent description says to use it proactively, honour that cue without waiting to be asked.',
    `Genuinely parallel launches are ONE message with multiple ${AGENT_TOOL_NAME} tool-use blocks (for example: three review agents launched together in a single message, one block each) — separate messages run serially.`,
    'Passing `isolation: "worktree"` hands the agent a temporary git worktree of its own. It requires a git repository (or a configured worktree-create hook); outside one, omit the parameter. A worktree the agent left untouched cleans itself up; one with changes survives, its path and branch riding back in the result.',
  )
  if (inProcess) {
    usage.push(
      'Inside this in-process teammate session the `run_in_background`, `name`, `team_name`, and `mode` parameters do not exist — subagents run synchronously only.',
    )
  } else if (isTeammate()) {
    usage.push(
      'In this teammate session the `name`, `team_name`, and `mode` parameters are unavailable — teammates cannot spawn teammates.',
    )
  }
  sections.push(`## Usage notes
${usage.map(note => `- ${note}`).join('\n')}`)

  if (forkOn) {
    sections.push(`## When to fork
Fork (omit \`subagent_type\`) when the tool traffic along the way is not worth keeping — a survey, a sweep, a lookup where only the conclusion matters. Research that reads many files forks well; implementation that needs your live judgment usually does not. Forks ride your prompt cache — that is what makes them cheap; a \`model\` override breaks the ride. A short lowercase \`name\` makes the fork steerable and visible in the teams panel.

No peeking: the result carries an output-file path — leave it unread and untailed unless the user asks outright, because doing so drags the fork's tool noise back into the context forking was meant to keep clean. The completion notification can be trusted.

No racing: once the launch is out, you know nothing about the outcome. Do not invent, guess at, or pre-announce what the child will find — in prose or in any structured form. The completion arrives later as a user-role turn and is never something you author. A question that lands before then gets a status answer, not a guess.

A fork prompt is a directive about what to DO — specific about scope in and out, and about what other agents cover — not a re-explanation of background the fork already inherited.`)
  }

  sections.push(`## Writing the prompt
${forkOn ? 'For fresh (typed) agents specifically: the' : 'The'} briefing should read as one written for a capable colleague arriving cold: they have not followed the conversation, do not know what was already tried, and do not know why the task matters. State the objective and the reason for it, what has already been established or eliminated, and enough surrounding situation that the agent can exercise judgment instead of following a narrow instruction. Ask for a short answer explicitly when one is wanted. For a lookup, supply the exact command; for an investigation, supply the question itself — a fixed procedure becomes useless the moment its premise turns out wrong. Clipped, imperative prompts yield shallow generic work.

Never hand the synthesis to the agent: prompts that defer the reasoning back to whatever the agent happens to discover are forbidden. A good prompt proves you already did the understanding — it carries file paths, line numbers, and the specific change wanted.`)

  if (forkOn) {
    sections.push(`## Examples
<example>
User: how many customers churned last quarter?
Assistant (thinking): the answer needs a sweep over exports whose tool output is not worth keeping — fork it.
Assistant: launches ${AGENT_TOOL_NAME} with name "churn" and a directive to compute the figure.
The turn ends there. The notification arrives in a separate turn as a user-role message — the assistant never pre-announces the result.
</example>
<example>
User (mid-wait): did the churn number come back yet?
Assistant: "Still running — I'll have it when the completion notification lands." (Status, not a fabricated result.)
</example>
<example>
User: get a second pair of eyes on this diff.
Assistant: launches a fresh typed agent (a reviewer) whose prompt carries the full context — the diff, the goal, what to check — because a typed agent starts cold.
</example>`)
  } else {
    sections.push(`## Examples
The examples below assume two fictional agents are configured:
- test-runner: runs the test suite and fixes failures (Tools: Bash, Read, Edit)
- greeting-responder: replies to greetings with a friendly joke (Tools: All tools)

<example>
User: write a parser for ISO-8601 durations, then get its tests green.
Assistant: writes the parser, then the test-runner agent takes the suite through its run-and-repair loop.
<commentary>Fresh code just landed, and the configured test-runner agent exists for exactly this follow-up — hand it the run-and-fix loop.</commentary>
</example>
<example>
User: hello!
Assistant: launches the greeting-responder agent.
<commentary>The configured greeting-responder says to use it for greetings — honour the "use proactively" cue.</commentary>
</example>`)
  }

  return sections.join('\n\n')
}
