import { PARSE_ABORTED, type Node } from '../../../bash/parser.js'
import { Walk } from './exactCommands.js'
import { Refusal, refuse } from './exactWords.js'
import { preCheckReason } from './preCheck.js'
import type { ParseForSecurityResult, SimpleCommand } from './reading.js'

const ABORT_KIND = 'PARSE_ABORT'
const ABORT_REASON = 'the shell parser did not finish reading this command; split it into simpler commands, or approve'

const REFUSED_NODE_TYPES: readonly string[] = [
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
]

function settle(command: string, root: Node | typeof PARSE_ABORTED): SimpleCommand[] {
  const preCheck = preCheckReason(command, root)
  if (preCheck !== null) refuse(preCheck)
  if (command.trim() === '') return []
  if (root === PARSE_ABORTED) refuse(ABORT_REASON, ABORT_KIND)
  const walk = new Walk()
  walk.node(root, new Map())
  return walk.commands
}

function verdictOf(refusal: Refusal): ParseForSecurityResult {
  if (refusal.nodeType === undefined) return { kind: 'too-complex', reason: refusal.reason }
  return { kind: 'too-complex', reason: refusal.reason, nodeType: refusal.nodeType }
}

export function parseForSecurityFromAst(command: string, root: Node | typeof PARSE_ABORTED): ParseForSecurityResult {
  try {
    return { kind: 'simple', commands: settle(command, root) }
  } catch (error) {
    if (error instanceof Refusal) return verdictOf(error)
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'too-complex', reason: `analysis failed unexpectedly: ${message}` }
  }
}

export function nodeTypeId(nodeType?: string): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const index = REFUSED_NODE_TYPES.indexOf(nodeType)
  return index === -1 ? 0 : index + 1
}
