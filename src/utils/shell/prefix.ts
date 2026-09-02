/**
 * Factory for model-assisted (small/fast model) command-prefix extractors
 * shared by the shell tools, with memoisation, dangerous-prefix rejection and
 * prefix validation.
 */
import { memoizeWithLRU } from '../memoize.js'
import { logForDebugging } from '../debug.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { sideQuery } from '../sideQuery.js'

/** A single command's prefix result. */
export type CommandPrefixResult = { commandPrefix: string | null }

/** A prefix result plus per-subcommand results. */
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

/** Configuration for a prefix extractor. */
export type PrefixExtractorConfig = {
  toolName: string
  policySpec: string
  querySource: string
  preCheck?: (command: string) => CommandPrefixResult | null
}

/** Sentinel answers (contract data). */
const NONE = 'none'
const INJECTION = 'command_injection_detected'

/** Shell prefixes never accepted bare (a wildcard rule lets any command through). */
const DANGEROUS_SHELL_PREFIXES: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'fish', 'csh', 'tcsh', 'ksh', 'dash', 'cmd', 'cmd.exe',
  'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'bash.exe',
])

/** The feature-gate key selecting the prompt shape (contract data; default false). */
const CORK_GATE = 'mercury_cork_m4q'

/** The API-error marker a query prepends to a failed answer. */
const API_ERROR_MARKER = 'API Error'

/** Extract the answer text from a model response. */
function extractAnswer(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textBlock = content.find((b: { type?: string }) => b.type === 'text') as { text?: string } | undefined
    return textBlock?.text ?? NONE
  }
  return NONE
}

/** Interpret a model answer into a prefix result (or null on API error). */
function interpretAnswer(answer: string, command: string): CommandPrefixResult | null {
  if (answer.startsWith(API_ERROR_MARKER)) return null // API error → null (not "no prefix")
  if (answer === INJECTION) return { commandPrefix: null }
  if (answer === 'git') return { commandPrefix: null } // exact, case-sensitive
  if (DANGEROUS_SHELL_PREFIXES.has(answer.toLowerCase())) return { commandPrefix: null }
  if (answer === NONE) return { commandPrefix: null }
  // Verify the answer is a genuine leading substring of the command.
  if (!command.startsWith(answer)) return { commandPrefix: null }
  return { commandPrefix: answer }
}

/** Build the model-facing prompts for one extraction. */
function buildPrompts(config: PrefixExtractorConfig, command: string): {
  systemPrompt: string
  userMessage: string
  cacheEnabled: boolean
} {
  const gateOn = getFeatureValue_CACHED_MAY_BE_STALE<boolean>(CORK_GATE, false)
  if (gateOn) {
    return {
      systemPrompt: `You process ${config.toolName} commands that an AI coding agent wants to run.\n\n${config.policySpec}`,
      userMessage: command,
      cacheEnabled: true,
    }
  }
  return {
    systemPrompt: `You process ${config.toolName} commands that an AI coding agent wants to run. The policy spec that follows defines how to determine the prefix of a ${config.toolName} command.`,
    userMessage: `${config.policySpec}\n\nCommand: ${command}`,
    cacheEnabled: false,
  }
}

/**
 * Build a memoised single-command prefix extractor. The returned function is
 * `(command, abortSignal, isNonInteractiveSession) => Promise<result | null>`
 * and exposes its LRU cache handle.
 */
export function createCommandPrefixExtractor(config: PrefixExtractorConfig) {
  const extract = async (
    command: string,
    abortSignal: AbortSignal,
    isNonInteractiveSession: boolean,
  ): Promise<CommandPrefixResult | null> => {
    // 1. Never issue a request in a test environment.
    if (process.env.NODE_ENV === 'test') return null
    // 2. Pre-check short-circuit.
    const preChecked = config.preCheck?.(command)
    if (preChecked !== null && preChecked !== undefined) return preChecked

    // 3. Slow-pre-flight warning timer.
    const warningTimer = setTimeout(() => {
      const message = `${config.toolName}Tool pre-flight check is running unusually slowly. Set ANTHROPIC_LOG=debug to see failed or slow API requests.`
      if (isNonInteractiveSession) {
        process.stderr.write(`${JSON.stringify({ level: 'warn', message })}\n`)
      } else {
        logForDebugging(message)
      }
    }, 10_000)

    try {
      const { systemPrompt, userMessage, cacheEnabled } = buildPrompts(config, command)
      const response = await sideQuery({
        systemPrompt,
        userPrompt: userMessage,
        signal: abortSignal,
        querySource: config.querySource,
        cacheSystemPrompt: cacheEnabled,
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

/**
 * Build a memoised subcommand-level extractor from a single-command extractor
 * plus a command-splitting function (sync or async, awaited first).
 */
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
    // Whole-command and each subcommand's prefix, concurrently.
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
