
import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import { FLAG_REGISTRY } from '../../../substrate/flagRegistry.js'
import type { ToolUseContext } from '../../../Tool.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { getInitialSettings } from '../../../utils/settings/settings.js'
import { searchToolsAvailability } from '../../../utils/ripgrep.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../SendMessageTool/constants.js'

export const MERCURY_GUIDE_AGENT_TYPE = 'mercury-guide'

export function isGuideAgentMounted(): boolean {
  if (
    isEnvTruthy(process.env.MERCURY_HOST_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    return false
  }
  return true
}

const DOCS_MAP_URL = 'https://docs.claude.com/llms.txt'

function clipSummary(summary: string): string {
  const sentenceEnd = summary.search(/[.!?](\s|$)/)
  const cut = sentenceEnd >= 0 ? summary.slice(0, sentenceEnd + 1) : summary
  return cut.length > 110 ? `${cut.slice(0, 110)}…` : cut
}

function buildGeneratedKnowledge(options: ToolUseContext['options']): string {
  const sections: string[] = []

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
  }

  try {
    if (FLAG_REGISTRY.length > 0) {
      const rows = FLAG_REGISTRY.map(
        flag => `- ${flag.env}: ${clipSummary(flag.summary)}`,
      ).join('\n')
      sections.push(`### Registered environment flags\n${rows}`)
    }
  } catch {
  }

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
  }

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
  }

  try {
    const names = (options.mcpClients ?? []).map(client => client.name)
    if (names.length > 0) {
      sections.push(
        `### Configured MCP servers\n${names.map(name => `- ${name}`).join('\n')}`,
      )
    }
  } catch {
  }

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
  }

  try {
    const settings = getInitialSettings()
    if (settings && Object.keys(settings).length > 0) {
      sections.push(
        `### User settings\n\`\`\`json\n${JSON.stringify(settings, null, 2)}\n\`\`\``,
      )
    }
  } catch {
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
  }
  return '- For product problems, point the user at the in-product feedback command (/bug).\n'
}

export const MERCURY_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: MERCURY_GUIDE_AGENT_TYPE,
  whenToUse:
    `Product, SDK, and API guide: questions about this harness's CLI surface (commands, settings, flags, features), building against the agent SDK, or the provider API (messages, tool use, caching, SDK usage). FIRST: when a guide agent is already running or recently finished, continue that one through the ${SEND_MESSAGE_TOOL_NAME} tool instead.`,
  tools: [
    'WebFetch',
    'WebSearch',
    'Read',
    ...(searchToolsAvailability().available ? ['Glob', 'Grep'] : ['Bash']),
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: 'inherit',
  permissionMode: 'dontAsk',
  getSystemPrompt: ({ toolUseContext }) =>
    buildGuidePrompt(toolUseContext.options),
}
