import { PARSE_ABORTED, parseCommandRaw, type Node } from '../../../../platform/shell/bash/parser.js'

const STATE_COMMANDS: ReadonlySet<string> = new Set(['cd', 'pushd', 'popd', 'alias', 'unalias'])
const STATE_STATEMENTS: ReadonlySet<string> = new Set(['variable_assignment', 'variable_assignments', 'declaration_command', 'unset_command', 'function_definition'])
const OPENED_STATEMENTS: ReadonlySet<string> = new Set(['program', 'list', 'redirected_statement', 'compound_statement'])

function stateLeftBy(node: Node, kept: string[]): void {
  if (STATE_STATEMENTS.has(node.type)) {
    kept.push(node.text)
    return
  }
  if (node.type === 'command') {
    const name = node.children.find(child => child.type === 'command_name')?.text ?? ''
    if (STATE_COMMANDS.has(name)) kept.push(node.text)
    return
  }
  if (OPENED_STATEMENTS.has(node.type)) for (const child of node.children) stateLeftBy(child, kept)
}

export async function stateStatements(script: string, parse: typeof parseCommandRaw = parseCommandRaw): Promise<string[]> {
  const root = await parse(script)
  if (!root || root === PARSE_ABORTED) return []
  const kept: string[] = []
  stateLeftBy(root, kept)
  return kept
}
