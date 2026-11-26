import { preparedCommandRoot, type Node } from '../../../../platform/shell/bash/parser.js'
import { parseForSecurityFromAst } from './exactParse.js'
import type { ParseForSecurityResult } from './reading.js'
import { asNode } from './shellViews.js'

export type CommandSpan = {
  declaration: boolean
  start: number
  end: number
  text: string
  exact: () => ParseForSecurityResult
  name: { text: string; rest: string; ansiC: boolean; word: () => string | undefined } | undefined
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

export type ClosingStatement = { at: number; after: '&&' | '||' | ';'; stage: string }

function lastStageOf(node: Node): Node | undefined {
  if (node.type === 'command' || (node.type === 'test_command' && node.children[0]?.type === '[')) return node
  if (node.type === 'pipeline') {
    const last = node.children[node.children.length - 1]
    return last === undefined ? undefined : lastStageOf(last)
  }
  if (node.type !== 'redirected_statement') return undefined
  const piped = node.children.flatMap(child => (child.type === 'heredoc_redirect' ? child.children.filter(inner => inner.type === 'pipeline') : []))
  const tail = piped[piped.length - 1] ?? node.children[0]
  return tail === undefined ? undefined : lastStageOf(tail)
}

function goesOnAfter(node: Node): Node[] {
  if (node.type === 'list') return node.children.slice(1)
  if (node.type !== 'redirected_statement') return []
  const heredoc = node.children.findLast(child => child.type === 'heredoc_redirect')
  const operator = heredoc?.children.findIndex(child => child.type === '&&' || child.type === '||') ?? -1
  return heredoc === undefined || operator === -1 ? [] : heredoc.children.slice(operator, operator + 2)
}

export function closingStatement(command: string): ClosingStatement | undefined {
  const root = preparedCommandRoot(command)
  const at = root === null || root.type !== 'program' ? null : placeIn(command, root)
  if (root === null || at === null) return undefined
  let node = root.children.findLast(child => child.type !== ';' && child.type !== 'comment')
  let after: ClosingStatement['after'] = ';'
  for (let onward = node === undefined ? [] : goesOnAfter(node); onward.length > 0; onward = node === undefined ? [] : goesOnAfter(node)) {
    const operator = onward[0]?.type
    if (operator !== '&&' && operator !== '||') return undefined
    after = operator
    node = onward[1]
  }
  const stage = node === undefined ? undefined : lastStageOf(node)
  if (node === undefined || stage === undefined) return undefined
  return { at: node.startIndex + at - root.startIndex, after, stage: stage.text }
}

const NAMES_WHAT_THE_SHELL_RUNS = /\bBASH_COMMAND\b|\bPS4\b|\bBASH_XTRACEFD\b/
const A_TRAP = /^(?:(?:builtin|command)\s+)?trap(?:\s|$)/
const SETS_OPTIONS = /^(?:(?:builtin|command)\s+)?(?:set|shopt)\s/
const TURNS_VERBOSE_ON = /\s-[A-Za-z]*v|\bverbose\b/

function readsTheLastStatus(node: Node, from: number): boolean {
  if (node.type === 'special_variable_name') return node.text === '?' && node.startIndex >= from
  return node.endIndex > from && node.children.some(child => readsTheLastStatus(child, from))
}

export function watchesItsShell(command: string, closing: ClosingStatement): boolean {
  const root = preparedCommandRoot(command)
  const at = root === null ? null : placeIn(command, root)
  if (root === null || at === null || NAMES_WHAT_THE_SHELL_RUNS.test(command)) return true
  const commands = commandSpans(root)
  if (/debug/i.test(command) && commands.some(span => A_TRAP.test(span.text))) return true
  if (commands.some(span => SETS_OPTIONS.test(span.text) && TURNS_VERBOSE_ON.test(span.text))) return true
  return readsTheLastStatus(root, closing.at - at + root.startIndex)
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
