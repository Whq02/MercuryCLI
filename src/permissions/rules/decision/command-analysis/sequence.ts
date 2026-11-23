import { parseCommandRaw, PARSE_ABORTED, preparedCommandRoot, type Node } from '../../../../platform/shell/bash/parser.js'

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
  const root = preparedCommandRoot(command)
  if (!root) return command
  const spans: Node[] = []
  const visit = (node: Node): void => {
    if (node.type === 'file_redirect') {
      const operator = node.children.find(child => child.type === '<' || WRITES.has(child.type))
      const descriptor = node.children.find(child => child.type === 'file_descriptor')
      const target = node.children.find(child => ['word', 'number', 'raw_string', 'string', 'concatenation'].includes(child.type))
      if (operator && target && (input ? operator.type === '<' : WRITES.has(operator.type))) {
        const duplicate = operator.type === '>&' && /^[0-9]+$/.test(target.text)
        if (!duplicate && (input || descriptor === undefined || descriptor.text === '1')) spans.push(node)
      }
      return
    }
    if (node.type === 'command_substitution' || node.type === 'process_substitution' || node.type === 'heredoc_body') return
    for (const child of node.children) visit(child)
  }
  visit(root)
  let text = root.text
  for (const span of spans.sort((a, b) => b.startIndex - a.startIndex)) {
    text = text.slice(0, span.startIndex - root.startIndex) + text.slice(span.endIndex - root.startIndex)
  }
  return text.trim() || command
}

export async function parseValidCommandRoot(command: string): Promise<unknown> {
  const root = await parseCommandRaw(command)
  if (!root || root === PARSE_ABORTED || root.type === 'ERROR') return null
  return root
}

export function retainPreparedCommand(command: string): unknown {
  return preparedCommandRoot(command)
}
