import { parseCommandRaw } from '../../../platform/shell/bash/parser.js'
import { checkSemantics, nodeTypeId, parseForSecurityFromAst, parseForSecurity, preparedSecurityParse, type ParseForSecurityResult, type SimpleCommand } from '../../../platform/shell/bash/ast.js'
import { extractOutputRedirections, splitCommand } from '../../../platform/shell/bash/commands.js'
import { tryParseShellCommand } from '../../../platform/shell/bash/shellQuote.js'
import { readShellCommands } from './command-analysis/total.js'
import type { CommandReading, ReadWorld, ShellDialect } from './command-analysis/reading.js'
import {
  classifyCommandName,
  deriveSecurityFlags,
  getAllCommandNames,
  getFileRedirections,
  parsePowerShellCommand,
  stripModulePrefix,
} from '../../../platform/shell/powershell/parser.js'

const bashLane = {
  parseCommandRaw,
  parseForSecurityFromAst,
  checkSemantics,
  nodeTypeId,
  splitCommand,
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

export { PARSE_ABORTED, preparedCommandRoot, withBashParseScope, type Node } from '../../../platform/shell/bash/parser.js'
export { extractHeredocs } from '../../../platform/shell/bash/heredoc.js'

export {
  checkSemantics,
  parseForSecurity,
  peelWrappers,
  preparedSecurityParse,
  shellCommandText,
  WILDCARD_REASON,
  type ParseForSecurityResult,
  type Redirect,
  type SimpleCommand,
} from '../../../platform/shell/bash/ast.js'

export {
  splitCommand,
  splitCommandWithOperators,
  splitListSegments,
} from '../../../platform/shell/bash/commands.js'

export { buildParsedCommandFromRoot, ParsedCommand } from '../../../platform/shell/bash/parsedCommand.js'

export {
  COMMON_ALIASES,
  deriveSecurityFlags,
  getAllCommands,
  getPipelineSegments,
  getVariablesByScope,
  isNullRedirectionTarget,
  isPowerShellParameter,
  type ParsedCommandElement,
  type ParsedPowerShellCommand,
} from '../../../platform/shell/powershell/parser.js'

export { UNREAD_PART, type CommandReading, type Layer, type ReadCommand, type ReadWorld, type ShellDialect, type ShellRead } from './command-analysis/reading.js'

export async function readCommand(text: string, dialect: ShellDialect, world: ReadWorld): Promise<CommandReading> {
  const read = await readShellCommands(text, dialect, world)
  const exact: ParseForSecurityResult = dialect === 'posix' ? await parseForSecurity(text) : { kind: 'parse-unavailable' }
  return { ...read, text, dialect, exact }
}

export const SHELL_C_MAX_DEPTH = 4

export function extractShellCScript(command: SimpleCommand): string | null {
  const [shell, flag, script] = command.argv
  if (command.argv.length !== 3 || command.envVars.length !== 0 || command.globOperand) return null
  if (!/^(?:\/(?:usr\/)?bin\/)?(?:sh|bash)$/.test(shell ?? '') || (flag !== '-c' && flag !== '-lc')) return null
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
export { stateStatements } from './command-analysis/stateStatements.js'
export { retainPreparedCommand } from './command-analysis/sequence.js'
export { absolutePath, layersOf, moveOf, programOf, wordKnown } from './command-analysis/layers.js'
export { oldFolderReturn, type OldFolderReturn } from './command-analysis/oldFolder.js'
export { printedBy, scriptSentToProgram, stdinProgram } from './command-analysis/scripts.js'
export { failShellReadingForTesting, readShellCommands, readShellCommandsFromText } from './command-analysis/total.js'
export { wordsAsWritten } from './command-analysis/written.js'
export { commandSpans, preparedCommandSpans, quotedArguments, type CommandSpan } from './command-analysis/commandSpans.js'
export { commandViews, placedPath } from './command-analysis/commandViews.js'
export { commandSubstitutionTexts, commandViewTexts } from './command-analysis/shellViews.js'
export { foldContinuations, readShellCommand, shellTextOutsideFileHeredocs } from './command-analysis/textReader.js'
