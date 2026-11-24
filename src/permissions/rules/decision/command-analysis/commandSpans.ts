import { preparedCommandRoot, type Node } from '../../../../platform/shell/bash/parser.js'
import { parseForSecurityFromAst } from './exactParse.js'
import type { ParseForSecurityResult } from './reading.js'

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
  const name = node.children.find(child => child.type === 'command_name')
  return {
    declaration: node.type === 'declaration_command',
    start: node.startIndex,
    end: node.endIndex,
    text: node.text,
    exact: () => parseForSecurityFromAst(node.text, node),
    name:
      name === undefined
        ? undefined
        : {
            text: name.text,
            rest: node.text.slice(name.endIndex - node.startIndex),
            ansiC: name.children[0]?.type === 'ansi_c_string',
            word: () => {
              const named = parseForSecurityFromAst(name.text, { ...node, children: [name] })
              return named.kind === 'simple' ? named.commands[0]?.argv[0] : undefined
            },
          },
  }
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

const NOT_WORDS: ReadonlySet<string> = new Set(['variable_assignment', 'file_redirect', 'herestring_redirect'])
const QUOTED_WORDS: ReadonlySet<string> = new Set(['raw_string', 'string'])

function placeIn(command: string, node: Node): number | null {
  if (command.endsWith(node.text)) return command.length - node.text.length
  return node.text.startsWith(command) ? 0 : null
}

export function quotedArguments(command: string, wanted: (argv: string[]) => number[]): { start: number; end: number }[] {
  const root = preparedCommandRoot(command)
  const at = root === null ? null : placeIn(command, root)
  if (root === null || at === null) return []
  const shift = at - root.startIndex
  const found: { start: number; end: number }[] = []
  const visit = (node: Node): void => {
    if (node.type === 'command') {
      const words = node.children.filter(child => !NOT_WORDS.has(child.type))
      const read = parseForSecurityFromAst(node.text, node)
      const argv = read.kind === 'simple' && read.commands.length === 1 ? read.commands[0]?.argv : undefined
      if (argv !== undefined && argv.length === words.length) {
        for (const index of wanted(argv)) {
          const word = words[index]
          if (word !== undefined && QUOTED_WORDS.has(word.type)) found.push({ start: word.startIndex + 1 + shift, end: word.endIndex - 1 + shift })
        }
      }
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return found
}
