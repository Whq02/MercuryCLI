import { parseCommandRaw } from '../../bash/parser.js'
import { checkSemantics, nodeTypeId, parseForSecurityFromAst } from '../../bash/ast.js'
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
