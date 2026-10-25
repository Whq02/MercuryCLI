import { parseCommandRaw } from '../../bash/parser.js'
import { checkSemantics, nodeTypeId, parseForSecurityFromAst, parseForSecurity, preparedSecurityParse, type ParseForSecurityResult, type SimpleCommand } from '../../bash/ast.js'
import { extractOutputRedirections, getCommandSubcommandPrefix, splitCommand } from '../../bash/commands.js'
import { tryParseShellCommand } from '../../bash/shellQuote.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  parsePowerShellCommand,
  stripModulePrefix,
} from '../../powershell/parser.js'

const bashLane = {
  parseCommandRaw,
  parseForSecurityFromAst,
  checkSemantics,
  nodeTypeId,
  splitCommand,
  getCommandSubcommandPrefix,
  extractOutputRedirections,
  tryParseShellCommand,
}

const powershellLane = {
  parsePowerShellCommand,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  stripModulePrefix,
  classifyCommandName,
}

type CommandAnalysisProvider = typeof bashLane & typeof powershellLane

export const pinnedCommandAnalysis: CommandAnalysisProvider = { ...bashLane, ...powershellLane }

export { PARSE_ABORTED, preparedCommandRoot, withBashParseScope, type Node } from '../../bash/parser.js'
export type { TreeSitterAnalysis } from '../../bash/treeSitterAnalysis.js'
export { extractHeredocs } from '../../bash/heredoc.js'

export {
  checkSemantics,
  parseForSecurity,
  peelWrappers,
  preparedSecurityParse,
  preparedSimpleCommand,
  shellCommandText,
  WILDCARD_REASON,
  type ParseForSecurityResult,
  type Redirect,
  type SimpleCommand,
} from '../../bash/ast.js'

export {
  extractInputRedirections,
  extractOutputRedirections,
  splitCommand,
  splitCommandWithOperators,
  splitListSegments,
  type CommandPrefixResult,
} from '../../bash/commands.js'

export { hasMalformedTokens, hasShellQuoteSingleQuoteBug, tryParseShellCommand } from '../../bash/shellQuote.js'
export { buildParsedCommandFromRoot, ParsedCommand, type IParsedCommand } from '../../bash/ParsedCommand.js'

export {
  COMMON_ALIASES,
  PS_TOKENIZER_DASH_CHARS,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getPipelineSegments,
  getVariablesByScope,
  hasCommandNamed,
  isNullRedirectionTarget,
  isPowerShellParameter,
  type ParsedCommandElement,
  type ParsedPowerShellCommand,
} from '../../powershell/parser.js'

export const SHELL_C_MAX_DEPTH = 4

export function extractShellCScript(command: SimpleCommand): string | null {
  const [shell, flag, script] = command.argv
  if (command.argv.length !== 3 || command.envVars.length !== 0 || command.globOperand) return null
  if (!/^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)$/.test(shell ?? '') || (flag !== '-c' && flag !== '-lc')) return null
  if (command.redirects.some(redirect => redirect.op !== '<' && redirect.op !== '<&')) return null
  return script ?? null
}

export async function prepareShellCScripts(parsed: ParseForSecurityResult, depth = 0): Promise<void> {
  if (parsed.kind !== 'simple' || depth >= SHELL_C_MAX_DEPTH) return
  for (const command of parsed.commands) {
    const script = extractShellCScript(command)
    if (script !== null) await prepareShellCScripts(await parseForSecurity(script), depth + 1)
  }
}

export function shellCCommands(commands: SimpleCommand[], depth = 0): SimpleCommand[] {
  if (depth >= SHELL_C_MAX_DEPTH) return commands
  return commands.flatMap(command => {
    const script = extractShellCScript(command)
    if (script === null) return [command]
    const inner = preparedSecurityParse(script)
    return inner.kind === 'simple' ? [command, ...shellCCommands(inner.commands, depth + 1)] : [command]
  })
}
