import { PARSE_ABORTED, parseCommandRaw, type Node } from '../../../bash/parser.js'
import { notBuilt } from '../../../../pi/holes.js'

const STATE_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'alias', 'unalias'])
const STATE_STATEMENTS: ReadonlySet<string> = new Set(['variable_assignment', 'variable_assignments', 'declaration_command', 'unset_command', 'function_definition'])
const OPENED_STATEMENTS: ReadonlySet<string> = new Set(['program', 'list', 'redirected_statement', 'compound_statement'])

function stateLeftBy(node: Node, kept: string[]): void {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/stateStatements.ts:7')
}

export async function stateStatements(script: string, parse: typeof parseCommandRaw = parseCommandRaw): Promise<string[]> {
  const root = await parse(script)
  if (!root || root === PARSE_ABORTED) return []
  const kept: string[] = []
  stateLeftBy(root, kept)
  return kept
}
