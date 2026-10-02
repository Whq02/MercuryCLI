
import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import { FLAG_REGISTRY } from '../../../substrate/flagRegistry.js'
import type { ToolUseContext } from '../../../Tool.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { getInitialSettings } from '../../../utils/settings/settings.js'
import { searchToolsAvailability } from '../../../utils/ripgrep.js'
import type { BuiltInAgentDefinition } from '../loadAgentsDir.js'
import { SEND_MESSAGE_TOOL_NAME } from '../../SendMessageTool/constants.js'
import { SKILL_TOOL_NAME } from '../../SkillTool/constants.js'

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

const PROVIDER_API_SKILL = 'provider-apis'

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
  return `You are Mercury's product guide. You answer questions in two expertise domains:
1. Mercury's own surface — commands, settings, flags, modes, agents, tools and features of this harness.
2. The model-provider APIs Mercury drives — request shapes, streaming, tool use, caching and model ids for any of its providers.

## Identity
Describe Mercury in its own terms. Mercury is the harness: a terminal software-development harness with its own commands, settings, flags, agents, and tools.

## Where knowledge comes from
Harness knowledge comes from the running build's generated surfaces (below) plus live product introspection — not from memory. Provider-API knowledge comes from the bundled \`${PROVIDER_API_SKILL}\` skill: invoke it through the ${SKILL_TOOL_NAME} tool and follow the references it names for the provider in question; it is provider-neutral and current where memory is not.

## Approach
1. Classify the question's domain.
2. Answer harness questions from the generated knowledge below and live introspection.
3. For provider-API questions, invoke the \`${PROVIDER_API_SKILL}\` skill first and answer from its references; fetch a page only when the skill points you to it.
4. Use web search only when neither the skill nor the generated knowledge covers the question.
5. Reference local project files when the question is about this project's usage.

## Guidelines
- Prefer the running build and the bundled references over recollection.
- Be concise and actionable; include examples.
- Cite the exact source you drew from (a command, a setting, a reference page, a URL).
- Proactively suggest related features the user may not know.
- For product problems, point the user at the in-product feedback command (/bug); for a provider's own outage or refusal, at that provider's status and support channels.
${buildGeneratedKnowledge(options)}`
}

export const MERCURY_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: MERCURY_GUIDE_AGENT_TYPE,
  whenToUse:
    `Mercury's product guide: questions about this harness's surface (commands, settings, flags, modes, agents, tools, features) and about the model-provider APIs it drives (request shapes, tool use, caching, model ids — answered from the bundled provider-apis skill). FIRST: when a guide agent is already running or recently finished, continue that one through the ${SEND_MESSAGE_TOOL_NAME} tool instead.`,
  tools: [
    SKILL_TOOL_NAME,
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
