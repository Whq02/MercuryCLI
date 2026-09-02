import {
  checkSemantics,
  nodeTypeId,
  parseForSecurityFromAst,
} from '../../bash/ast.js'
import {
  extractOutputRedirections,
  getCommandSubcommandPrefix,
  splitCommand_DEPRECATED,
} from '../../bash/commands.js'
import { parseCommandRaw } from '../../bash/parser.js'
import { tryParseShellCommand } from '../../bash/shellQuote.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  parsePowerShellCommand,
  stripModulePrefix,
} from '../../powershell/parser.js'

export type {
  ParseForSecurityResult,
  Redirect,
  SimpleCommand,
} from '../../bash/ast.js'
export type { CommandPrefixResult } from '../../bash/commands.js'
export { PARSE_ABORTED, type Node } from '../../bash/parser.js'
export type {
  ParsedCommandElement,
  ParsedPowerShellCommand,
} from '../../powershell/parser.js'
export { PS_TOKENIZER_DASH_CHARS } from '../../powershell/parser.js'

export {
  extractOutputRedirections,
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
  splitCommandWithOperators,
} from '../../bash/commands.js'
export { parseForSecurity } from '../../bash/ast.js'
export type { TreeSitterAnalysis } from '../../bash/treeSitterAnalysis.js'
export { extractHeredocs } from '../../bash/heredoc.js'
export {
  hasMalformedTokens,
  hasShellQuoteSingleQuoteBug,
  tryParseShellCommand,
} from '../../bash/shellQuote.js'
export {
  buildParsedCommandFromRoot,
  type IParsedCommand,
  ParsedCommand,
} from '../../bash/ParsedCommand.js'
export {
  COMMON_ALIASES,
  commandHasArgAbbreviation,
  deriveSecurityFlags,
  getAllCommands,
  getPipelineSegments,
  getVariablesByScope,
  hasCommandNamed,
  isNullRedirectionTarget,
  isPowerShellParameter,
} from '../../powershell/parser.js'

export interface CommandAnalysisProvider {
  parseCommandRaw: typeof parseCommandRaw
  parseForSecurityFromAst: typeof parseForSecurityFromAst
  checkSemantics: typeof checkSemantics
  nodeTypeId: typeof nodeTypeId
  splitCommand: typeof splitCommand_DEPRECATED
  getCommandSubcommandPrefix: typeof getCommandSubcommandPrefix
  extractOutputRedirections: typeof extractOutputRedirections
  tryParseShellCommand: typeof tryParseShellCommand
  parsePowerShellCommand: typeof parsePowerShellCommand
  deriveSecurityFlags: typeof deriveSecurityFlags
  getAllCommandNames: typeof getAllCommandNames
  getFileRedirections: typeof getFileRedirections
  stripModulePrefix: typeof stripModulePrefix
  classifyCommandName: typeof classifyCommandName
}

export const pinnedCommandAnalysis: CommandAnalysisProvider = {
  parseCommandRaw,
  parseForSecurityFromAst,
  checkSemantics,
  nodeTypeId,
  splitCommand: splitCommand_DEPRECATED,
  getCommandSubcommandPrefix,
  extractOutputRedirections,
  tryParseShellCommand,
  parsePowerShellCommand,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  stripModulePrefix,
  classifyCommandName,
}
