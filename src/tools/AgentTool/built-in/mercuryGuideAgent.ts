// Product/SDK/API guide agent. Mercury layer: generated build
// knowledge (command roster + flag registry + configured surfaces) and the
// identity discipline — the harness is described in its own terms.
//
// This producer genuinely needs the live tool-use context (it lists the
// running build's commands and configuration), so it destructures its
// parameter: called without one it throws, and the roster prover reads this
// file's source for the static identity words instead.

import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import { FLAG_REGISTRY } from '../../../substrate/flagRegistry.js'
import type { ToolUseContext } from '../../../Tool.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { getInitialSettings } from '../../../utils/settings/settings.js'
import { searchToolsAvailability } from '../../../utils/ripgrep.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../SendMessageTool/constants.js'

/** The type slug as ONE seam constant: the roster, the agents list, the
 *  bundled debug skill, and dispatch all reference it. */
export const MERCURY_GUIDE_AGENT_TYPE = 'mercury-guide'

/**
 * The guide's mount law — the ONE owner of "is the guide in this session's
 * roster": the guide mounts in EVERY session, headless `-p` included; the
 * one opt-out is the SDK builtin-agent kill (MERCURY_SDK_DISABLE_BUILTIN_AGENTS
 * in a non-interactive session), which empties the roster it rides in. The
 * entrypoint no longer suppresses it: main.tsx stamps `sdk` for every
 * non-interactive run, so an operator's own headless run and a programmatic
 * SDK consumer were indistinguishable, and a headless model that cannot ask
 * how Mercury works was the cold-start failure by construction (the
 * agent-experience benchmark's guide-question row). The roster assembles by
 * this predicate, and the system prompt advertises the guide only where it
 * answers true — an OFF surface is never advertised.
 */
export function isGuideAgentMounted(): boolean {
  if (
    isEnvTruthy(process.env.MERCURY_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return false
  }
  return true
}

/** The provider's published documentation map — cited once, reused for both
 *  the SDK and the API domain (contract data). */
const DOCS_MAP_URL = 'https://docs.claude.com/llms.txt'

/** Clip a registry summary at its first sentence end, then hard-clip. */
function clipSummary(summary: string): string {
  const sentenceEnd = summary.search(/[.!?](\s|$)/)
  const cut = sentenceEnd >= 0 ? summary.slice(0, sentenceEnd + 1) : summary
  return cut.length > 110 ? `${cut.slice(0, 110)}…` : cut
}

function buildGeneratedKnowledge(options: ToolUseContext['options']): string {
  const sections: string[] = []

  // 1. The built-in command roster from the running build (authoritative).
  try {
    const commands = (options.commands ?? []).filter(
      (command: any) => command && command.isHidden !== true,
    )
    if (commands.length > 0) {
      const rows = commands
        .map(
          (command: any) =>
            `- /${String(command.userFacingName?.() ?? command.name)}: ${String(command.description ?? '')}`,
        )
        .join('\n')
      sections.push(
        `### Built-in commands (authoritative — from the running build)\n${rows}`,
      )
    }
  } catch {
    // Roster failures are swallowed — the section is simply absent.
  }

  // 2. The registered environment-flag table.
  try {
    if (FLAG_REGISTRY.length > 0) {
      const rows = FLAG_REGISTRY.map(
        flag => `- ${flag.env}: ${clipSummary(flag.summary)}`,
      ).join('\n')
      sections.push(`### Registered environment flags\n${rows}`)
    }
  } catch {
    // Registry failures are swallowed.
  }

  // 3. Custom skills (skill-backed commands in the running roster).
  try {
    const skillCommands = (options.commands ?? []).filter(
      (command: any) => command && command.isSkillCommand === true,
    )
    if (skillCommands.length > 0) {
      const rows = skillCommands
        .map(
          (command: any) =>
            `- ${String(command.userFacingName?.() ?? command.name)}: ${String(command.description ?? '')}`,
        )
        .join('\n')
      sections.push(`### Custom skills\n${rows}`)
    }
  } catch {
    /* absent section */
  }

  // 4. Custom (non-built-in) active agents with their cues.
  try {
    const agents = (options.agentDefinitions?.activeAgents ?? []).filter(
      agent => agent.source !== 'built-in',
    )
    if (agents.length > 0) {
      const rows = agents
        .map(agent => `- ${agent.agentType}: ${agent.whenToUse}`)
        .join('\n')
      sections.push(`### Custom agents\n${rows}`)
    }
  } catch {
    /* absent section */
  }

  // 5. Configured MCP server names.
  try {
    const names = (options.mcpClients ?? []).map(client => client.name)
    if (names.length > 0) {
      sections.push(
        `### Configured MCP servers\n${names.map(name => `- ${name}`).join('\n')}`,
      )
    }
  } catch {
    /* absent section */
  }

  // 6. Extension skills.
  try {
    const extensionSkills = (options.commands ?? []).filter(
      (command: any) => command && command.extensionInfo?.manifest?.name,
    )
    if (extensionSkills.length > 0) {
      const rows = extensionSkills
        .map(
          (command: any) =>
            `- ${String(command.userFacingName?.() ?? command.name)} (${String(command.extensionInfo.manifest.name)})`,
        )
        .join('\n')
      sections.push(`### Extension skills\n${rows}`)
    }
  } catch {
    /* absent section */
  }

  // 7. The user's settings JSON.
  try {
    const settings = getInitialSettings()
    if (settings && Object.keys(settings).length > 0) {
      sections.push(
        `### User settings\n\`\`\`json\n${JSON.stringify(settings, null, 2)}\n\`\`\``,
      )
    }
  } catch {
    /* absent section */
  }

  if (sections.length === 0) return ''
  return `\n\n## The user's current configuration\n\n${sections.join('\n\n')}\n\nConsider these configured features when answering, and proactively suggest them where they apply.`
}

function buildGuidePrompt(options: ToolUseContext['options']): string {
  return `You are Mercury's product and API guide. You answer questions in three expertise domains:
1. Mercury's own CLI surface — commands, settings, flags, and features of this harness.
2. The agent SDK — building custom agents against the provider's SDK.
3. The provider API — messages, tool use, caching, and general SDK usage.

## Identity discipline
Describe Mercury in its own terms. Never frame it through lineage — no "built on", "based on", or comparisons to other products' internals. Mercury is the harness; its features are its own.

## Where knowledge comes from
Harness knowledge comes from the running build's generated surfaces (below) plus live product introspection — not from memory. For SDK and API questions, fetch the provider's documentation map and follow it:

${DOCS_MAP_URL}

That one map covers both domains — the agent SDK (agent loops, tools, MCP, permissions) and the provider API (messages, streaming, tool use, prompt caching, token counting, models).

## Approach
1. Classify the question's domain.
2. Answer harness questions from the generated knowledge below and live introspection.
3. For SDK/API questions, fetch the documentation map, identify the specific pages that apply, and fetch those.
4. Use web search only when the documentation does not cover the question.
5. Reference local project files when the question is about this project's usage.

## Guidelines
- Prefer official documentation over recollection.
- Be concise and actionable; include examples.
- Cite the exact URLs you drew from.
- Proactively suggest related features the user may not know.
${buildFeedbackGuideline()}${buildGeneratedKnowledge(options)}`
}

function buildFeedbackGuideline(): string {
  try {
    const baseUrl = process.env.ANTHROPIC_BASE_URL
    if (baseUrl && !/anthropic\.com|claude\.ai/.test(baseUrl)) {
      return '- For problems with this third-party service backend, point the user at the service\'s own issue channel rather than the product feedback command.\n'
    }
  } catch {
    /* default */
  }
  return '- For product problems, point the user at the in-product feedback command (/bug).\n'
}

export const MERCURY_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: MERCURY_GUIDE_AGENT_TYPE,
  whenToUse:
    `Product, SDK, and API guide: questions about this harness's CLI surface (commands, settings, flags, features), building against the agent SDK, or the provider API (messages, tool use, caching, SDK usage). FIRST: when a guide agent is already running or recently finished, continue that one through the ${SEND_MESSAGE_TOOL_NAME} tool instead.`,
  tools: [
    'WebFetch',
    // WebSearch (vendored) DELIBERATELY without ProviderSearch:
    // the guide agent's searches must never spend
    // the provider account — the keyed/keyless vendored walk serves it on
    // every home.
    'WebSearch',
    'Read',
    ...(searchToolsAvailability().available ? ['Glob', 'Grep'] : ['Bash']),
  ],
  source: 'built-in',
  baseDir: 'built-in',
  // Inherits the parent model — the never-lightweight rule applied to an
  // agent whose ancestor pinned a lightweight tier.
  model: 'inherit',
  permissionMode: 'dontAsk',
  getSystemPrompt: ({ toolUseContext }) =>
    buildGuidePrompt(toolUseContext.options),
}
