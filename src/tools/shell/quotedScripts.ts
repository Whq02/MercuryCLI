import { pinnedCommandAnalysis, preparedCommandRoot, type Node } from '../../permissions/rules/decision/commandAnalysis.js'
import type { QuotedScript } from '../../permissions/rules/uncPath.js'
import { scriptArgumentIndexes } from './pathValidation.js'

const NOT_WORDS: ReadonlySet<string> = new Set(['variable_assignment', 'file_redirect', 'herestring_redirect'])
const QUOTED_WORDS: ReadonlySet<string> = new Set(['raw_string', 'string'])

function quotedScriptsUnder(node: Node, found: QuotedScript[]): void {
  if (node.type === 'command') {
    const words = node.children.filter(child => !NOT_WORDS.has(child.type))
    const read = pinnedCommandAnalysis.parseForSecurityFromAst(node.text, node)
    const argv = read.kind === 'simple' && read.commands.length === 1 ? read.commands[0]?.argv : undefined
    if (argv !== undefined && argv.length === words.length) {
      for (const index of scriptArgumentIndexes(argv[0] ?? '', argv.slice(1))) {
        const word = words[index + 1]
        if (word !== undefined && QUOTED_WORDS.has(word.type)) found.push({ start: word.startIndex + 1, end: word.endIndex - 1 })
      }
    }
  }
  for (const child of node.children) quotedScriptsUnder(child, found)
}

export function quotedScripts(command: string): QuotedScript[] {
  const root = preparedCommandRoot(command)
  const found: QuotedScript[] = []
  if (root !== null) quotedScriptsUnder(root, found)
  return found
}
