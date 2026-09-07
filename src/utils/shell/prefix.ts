import { memoizeWithLRU } from '../memoize.js'
import { logForDebugging } from '../debug.js'
import { sideQuery } from '../sideQuery.js'

export type CommandPrefixResult = { commandPrefix: string | null }

export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

export type PrefixExtractorConfig = {
  toolName: string
  policySpec: string
  querySource: string
  preCheck?: (command: string) => CommandPrefixResult | null
}

const NONE = 'none'
const INJECTION = 'command_injection_detected'

const DANGEROUS_SHELL_PREFIXES: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'cmd', 'cmd.exe',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash.exe',
])

const API_ERROR_MARKER = 'API Error'

function extractAnswer(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textBlock = content.find((b: { type?: string }) => b.type === 'text') as { text?: string } | undefined
    return textBlock?.text ?? NONE
  }
  return NONE
}

function interpretAnswer(answer: string, command: string): CommandPrefixResult | null {
  if (answer.startsWith(API_ERROR_MARKER)) return null
  if (answer === INJECTION) return { commandPrefix: null }
  if (answer === 'git') return { commandPrefix: null }
  if (DANGEROUS_SHELL_PREFIXES.has(answer.toLowerCase())) return { commandPrefix: null }
  if (answer === NONE) return { commandPrefix: null }
  if (!command.startsWith(answer)) return { commandPrefix: null }
  return { commandPrefix: answer }
}

function buildPrompts(config: PrefixExtractorConfig, command: string): {
  systemPrompt: string
  userMessage: string
} {
  return {
    systemPrompt: `You process ${config.toolName} commands that an AI coding agent wants to run. The policy spec that follows defines how to determine the prefix of a ${config.toolName} command.`,
    userMessage: `${config.policySpec}\n\nCommand: ${command}`,
  }
}

export function createCommandPrefixExtractor(config: PrefixExtractorConfig) {
  const extract = async (
    command: string,
    abortSignal: AbortSignal,
    isNonInteractiveSession: boolean,
  ): Promise<CommandPrefixResult | null> => {
    if (process.env.NODE_ENV === 'test') return null
    const preChecked = config.preCheck?.(command)
    if (preChecked !== null && preChecked !== undefined) return preChecked

    const warningTimer = setTimeout(() => {
      const message = `${config.toolName}Tool pre-flight check is running unusually slowly. Set ANTHROPIC_LOG=debug to see failed or slow API requests.`
      if (isNonInteractiveSession) {
        process.stderr.write(`${JSON.stringify({ level: 'warn', message })}\n`)
      } else {
        logForDebugging(message)
      }
    }, 10_000)

    try {
      const { systemPrompt, userMessage } = buildPrompts(config, command)
      const response = await sideQuery({
        systemPrompt,
        userPrompt: userMessage,
        signal: abortSignal,
        querySource: config.querySource,
        cacheSystemPrompt: false,
        useSmallFastModel: true,
      } as never)
      const answer = extractAnswer((response as { content?: unknown }).content).trim()
      return interpretAnswer(answer, command)
    } finally {
      clearTimeout(warningTimer)
    }
  }

  return memoizeWithLRU(extract, (command: string) => command, 200)
}

export function createSubcommandPrefixExtractor(
  getPrefix: (command: string, abortSignal: AbortSignal, isNonInteractiveSession: boolean) => Promise<CommandPrefixResult | null>,
  splitCommand: (command: string) => string[] | Promise<string[]>,
) {
  const extract = async (
    command: string,
    abortSignal: AbortSignal,
    isNonInteractiveSession: boolean,
  ): Promise<CommandSubcommandPrefixResult | null> => {
    const subcommands = await splitCommand(command)
    const [whole, ...subResults] = await Promise.all([
      getPrefix(command, abortSignal, isNonInteractiveSession),
      ...subcommands.map(sub => getPrefix(sub, abortSignal, isNonInteractiveSession)),
    ])
    if (whole === null) return null

    const subcommandPrefixes = new Map<string, CommandPrefixResult>()
    subcommands.forEach((sub, index) => {
      const result = subResults[index]
      if (result !== null && result !== undefined) subcommandPrefixes.set(sub, result)
    })
    return { ...whole, subcommandPrefixes }
  }

  return memoizeWithLRU(extract, (command: string) => command, 200)
}
