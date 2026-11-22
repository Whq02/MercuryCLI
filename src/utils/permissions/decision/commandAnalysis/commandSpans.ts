import { preparedCommandRoot, type Node } from '../../../bash/parser.js'
import { parseForSecurityFromAst } from './exact.js'
import type { ParseForSecurityResult } from './reading.js'
import { notBuilt } from '../../../../pi/holes.js'

export type CommandSpan = {
  declaration: boolean
  start: number
  end: number
  text: string
  exact: () => ParseForSecurityResult
  name: { text: string; rest: string; ansiC: boolean; word: () => string | undefined } | undefined
}

function asNode(value: unknown): Node | null {
  if (value && typeof value === 'object' && 'type' in value && 'children' in value) {
    return value as Node
  }
  return null
}

function spanOf(node: Node): CommandSpan {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/commandSpans.ts:21')
}

export function commandSpans(rootNode: unknown, order: 'written' | 'lastFirst' = 'written'): CommandSpan[] {
  const root = asNode(rootNode)
  if (root === null) return []
  const spans: CommandSpan[] = []
  if (order === 'written') {
    const visit = (node: Node): void => {
      if (node.type === 'command' || node.type === 'declaration_command') spans.push(spanOf(node))
      for (const child of node.children) visit(child)
    }
    visit(root)
    return spans
  }
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'command' || node.type === 'declaration_command') spans.push(spanOf(node))
    stack.push(...node.children)
  }
  return spans
}

export function preparedCommandSpans(command: string): CommandSpan[] | null {
  const root = preparedCommandRoot(command)
  if (!root || root.type === 'ERROR') return null
  return commandSpans(root)
}
