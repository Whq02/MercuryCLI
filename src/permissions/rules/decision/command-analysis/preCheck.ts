import { hiddenCommandCharacterReason } from '../../../../platform/text/unicodeSanitization.js'
import { extractHeredocs } from '../../../../platform/shell/bash/heredoc.js'
import { PARSE_ABORTED, type Node } from '../../../../platform/shell/bash/parser.js'

const ESCAPED_BLANK_RE = /\\[ \t]/
const MIDWORD_CONTINUATION_RE = /[^ \t\n\\]\\\n/
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/

function maskQuotedBraces(command: string): string {
  let out = ''
  let state: 'plain' | 'single' | 'double' = 'plain'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (state === 'plain') {
      if (ch === '\\' && i + 1 < command.length) {
        out += ch + command[i + 1]
        i++
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      out += ch
      continue
    }
    if (state === 'single') {
      if (ch === "'") {
        state = 'plain'
        out += ch
      } else {
        out += ch === '{' ? ' ' : ch
      }
      continue
    }
    if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
      const next = command[i + 1] as string
      out += ch + (next === '{' ? ' ' : next)
      i++
      continue
    }
    if (ch === '"') {
      state = 'plain'
      out += ch
    } else {
      out += ch === '{' ? ' ' : ch
    }
  }
  return out
}

const PRE_CHECKS: ReadonlyArray<readonly [(command: string) => boolean, string]> = [
  [
    command => ESCAPED_BLANK_RE.test(command) || MIDWORD_CONTINUATION_RE.test(command),
    'Contains backslash-escaped whitespace, which the shell and the parser tokenize differently',
  ],
  [
    command => command.includes('{') && BRACE_WITH_QUOTE_RE.test(maskQuotedBraces(command)),
    'Bash needs approval for this brace form: it is not a simple command. Run the commands separately with literal arguments.',
  ],
]

export function preCheckReason(command: string, root: Node | typeof PARSE_ABORTED): string | null {
  const hidden = hiddenCommandCharacterReason(command, false)
  if (hidden !== null) return hidden
  const withoutGroupBraces = command.split('')
  const visit = (node: Node): void => {
    if (node.type === 'compound_statement') {
      for (const child of node.children) {
        if (child.type === '{' || child.type === '}') withoutGroupBraces[child.startIndex] = ' '
      }
    }
    for (const child of node.children) visit(child)
  }
  if (root !== PARSE_ABORTED) visit(root)
  const outsideHeredocs = extractHeredocs(withoutGroupBraces.join(''), { quotedOnly: true }).processedCommand
  for (const [trips, reason] of PRE_CHECKS) if (trips(outsideHeredocs)) return reason
  return null
}
