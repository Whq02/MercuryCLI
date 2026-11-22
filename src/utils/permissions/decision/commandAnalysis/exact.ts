import { PARSE_ABORTED, type Node } from '../../../bash/parser.js'
import { Walk } from './exactCommands.js'
import { Refusal, refuse } from './exactWords.js'
import { preCheckReason } from './preCheck.js'
import type { ParseForSecurityResult, SimpleCommand } from './reading.js'
import { notBuilt } from '../../../../pi/holes.js'

const ABORT_KIND = 'PARSE_ABORT'
const ABORT_REASON = 'the shell parser did not finish reading this command; split it into simpler commands, or approve'

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
  return notBuilt('src/utils/permissions/decision/commandAnalysis/exact.ts:46')
}

export function nodeTypeId(nodeType?: string): number {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/exact.ts:58')
}
