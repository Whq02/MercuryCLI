import { parseCommandRaw, PARSE_ABORTED, preparedCommandRoot, type Node } from '../../../bash/parser.js'
import { notBuilt } from '../../../../pi/holes.js'

const SEPARATORS = new Set(['&&', '||', ';', '&', '|', '|&', '\n'])
const CONTAINERS = new Set(['program', 'list', 'pipeline'])
const WRITES = new Set(['>', '>>', '>|', '&>', '&>>', '>&'])

function asNode(value: unknown): Node | null {
  if (value && typeof value === 'object' && 'type' in value && 'children' in value) {
    return value as Node
  }
  return null
}

export function isOutputWriteOperator(op: string): boolean {
  return WRITES.has(op)
}

export function splitCommandWithOperators(command: string): string[] {
  if (command.trim() === '') return []
  const root = preparedCommandRoot(command)
  if (!root || root.type === 'ERROR') return [command]
  const result: string[] = []
  const visit = (node: Node): void => {
    if (CONTAINERS.has(node.type)) {
      for (const child of node.children) visit(child)
    } else if (SEPARATORS.has(node.type)) result.push(node.type)
    else if (node.type !== 'comment') result.push(node.text)
  }
  visit(root)
  return result
}

export function splitListSegments(command: string): string[] {
  return splitCommandWithOperators(command).filter(part => !SEPARATORS.has(part))
}

export function pipeSpans(rootNode: unknown): Array<{ start: number; end: number }> {
  const root = asNode(rootNode)
  if (!root) return []
  const spans: Array<{ start: number; end: number }> = []
  const visit = (node: Node): void => {
    if (!CONTAINERS.has(node.type) && node.type !== 'redirected_statement' && node.type !== 'negated_command') return
    for (const child of node.children) {
      if (child.type === '|' || child.type === '|&') spans.push({ start: child.startIndex, end: child.endIndex })
      else visit(child)
    }
  }
  visit(root)
  return spans.sort((a, b) => a.start - b.start)
}

export function withoutRedirects(command: string, input: boolean): string {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/sequence.ts:52')
}

export async function parseValidCommandRoot(command: string): Promise<unknown> {
  const root = await parseCommandRaw(command)
  if (!root || root === PARSE_ABORTED || root.type === 'ERROR') return null
  return root
}

export function retainPreparedCommand(command: string): unknown {
  return preparedCommandRoot(command)
}
