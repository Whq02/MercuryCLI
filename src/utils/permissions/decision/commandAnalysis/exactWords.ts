import { misreadWordList, type Node, type WordListFault } from '../../../bash/parser.js'
import type { Redirect } from './reading.js'

export const WILDCARD_REASON = 'an unquoted wildcard expands to paths at runtime; quote it as text or spell out the paths, or approve'

export class Refusal {
  constructor(
    readonly reason: string,
    readonly nodeType?: string,
  ) {}
}

export function refuse(reason: string, nodeType?: string): never {
  throw new Refusal(reason, nodeType)
}

export function refuseNode(node: Node): never {
  if (node.type === 'ERROR') {
    refuseWordListFault(misreadWordList(node), node.type)
    refuse('the shell parser found incomplete or invalid syntax; fix the quotes or operators, or approve', node.type)
  }
  if (node.type === 'command_substitution') refuse('a command substitution supplies an argument at runtime; spell out its value or run the inner command separately, or approve', node.type)
  if (node.type === 'process_substitution') refuse('a process substitution starts another command; run that command separately, or approve', node.type)
  if (node.type === 'simple_expansion' || node.type === 'expansion') refuse(`the expansion ${JSON.stringify(node.text)} supplies a value at runtime; spell out the value, or approve`, node.type)
  const construct = node.type.replaceAll('_', ' ')
  refuse(`the shell parser cannot establish the effect of this ${construct}; split it into explicit commands, or approve`, node.type)
}

const UNKNOWN_SUBSTITUTION = '__MERCURY_UNKNOWN_SUBSTITUTION__'
export const UNKNOWN_VALUE = '__MERCURY_UNKNOWN_VALUE__'
export const UNKNOWN_INTEGER = '__MERCURY_UNKNOWN_INTEGER__'
export const GLOB_ITEM = '__MERCURY_GLOB_ITEM__'

export function isKnown(value: string): boolean {
  return !value.includes(UNKNOWN_SUBSTITUTION) && !value.includes(UNKNOWN_VALUE) && !value.includes(UNKNOWN_INTEGER)
}

export function integerValued(value: string | undefined): boolean {
  return value !== undefined && (value === UNKNOWN_INTEGER || ARITHMETIC_INTEGER_RE.test(value))
}

export type Scope = Map<string, string>

const SHELL_VARIABLES: ReadonlySet<string> = new Set([
  'HOME',
  'PWD',
  'OLDPWD',
  'USER',
  'LOGNAME',
  'SHELL',
  'PATH',
  'HOSTNAME',
  'UID',
  'EUID',
  'PPID',
  'RANDOM',
  'SECONDS',
  'LINENO',
  'TMPDIR',
  'BASH_VERSION',
  'BASHPID',
  'SHLVL',
  'HISTFILE',
  'IFS',
])

const SPECIAL_VARIABLES: ReadonlySet<string> = new Set(['?', '$', '!', '#', '0', '-'])

export function childOfKind(node: Node, kind: string): Node | undefined {
  return node.children.find((child: Node) => child.type === kind)
}

const BRACE_EXPANSION_RE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/

function refuseBraceExpansion(node: Node): void {
  if (BRACE_EXPANSION_RE.test(node.text)) refuse('contains brace expansion syntax', node.type)
}

export function refuseWordListFault(fault: WordListFault | null, nodeType: string): void {
  if (fault === 'unplaced') refuse('the shell parser cannot place the words of this command in its text; split it into explicit commands, or approve', nodeType)
  if (fault === 'line-break') refuse('a line break stands between the words of one command, and the shell runs what follows it as a command of its own; put a ; or && between the two commands, or approve', nodeType)
}

function unescapeWord(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

function unquotedWildcard(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue }
    if ('*?['.includes(text[index]!)) return true
  }
  return false
}

export type Operand = { glob: boolean }

function unescapeQuoted(text: string): string {
  return text.replace(/\\([$`"\\])/g, '$1')
}

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const NEWLINE_COMMENT_RE = /\n[ \t]*#/
export const PROCESS_ENVIRON_RE = /\/proc\/.*\/environ/
export const SYSTEM_CALL_RE = /\bsystem\s*\(/

type Reference = { value: string; unknown: boolean }

const ARITHMETIC_INTEGER_RE: RegExp = /^[+-]?(?:0[xX][0-9A-Fa-f]+|[0-9]+#[0-9A-Za-z@_]+|[0-9]+)$/

const ARITHMETIC_OPERATORS: ReadonlySet<string> = new Set([
  '$((',
  '))',
  '(',
  ')',
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '<<',
  '>>',
  '&',
  '|',
  '^',
  '~',
  '!',
  '&&',
  '||',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '?',
  ':',
  ',',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '<<=',
  '>>=',
  '&=',
  '|=',
  '^=',
])

function reference(node: Node, scope: Scope, quoted: boolean, operand?: Operand): Reference {
  const nameNode = childOfKind(node, 'variable_name') ?? childOfKind(node, 'special_variable_name')
  if (!nameNode) refuse('variable reference has no name', node.type)
  const name = nameNode.text

  if (scope.has(name)) {
    const tracked = scope.get(name)!
    if (tracked.startsWith(GLOB_ITEM)) {
      if (!operand) refuse(WILDCARD_REASON, node.type)
      operand.glob = true
      return { value: tracked.slice(GLOB_ITEM.length), unknown: false }
    }
    if (!isKnown(tracked)) {
      if (node.type === 'expansion') refuseNode(node)
      if (quoted) return { value: tracked, unknown: true }
      refuse(`Bash needs approval for $${name} because its value is unknown. Use its literal path or value.`, node.type)
    }
    if (!quoted) {
      if (tracked === '') {
        refuse(`$${name} is empty and the shell would drop the argument, shifting what actually runs`, node.type)
      }
      if (/[ \t\n*?[]/.test(tracked)) {
        refuse(`value of $${name} would be word-split or glob-expanded into a different argv`, node.type)
      }
    }
    return { value: tracked, unknown: false }
  }

  if (node.type === 'expansion') refuseNode(node)
  if (quoted && (SHELL_VARIABLES.has(name) || SPECIAL_VARIABLES.has(name))) {
    return { value: UNKNOWN_VALUE, unknown: true }
  }
  refuse(`reference to variable $${name} whose value is not statically known`, node.type)
}

function validateArithmetic(node: Node, scope: Scope): void {
  for (const child of node.children) {
    if (child.children.length === 0) {
      const token = child.text.trim()
      if (ARITHMETIC_OPERATORS.has(token) || ARITHMETIC_INTEGER_RE.test(token)) continue
      if (child.type === 'variable_name' && integerValued(scope.get(token))) continue
      refuse(`arithmetic expression contains a non-literal term ${JSON.stringify(token)}`, node.type)
    }
    if (
      child.type === 'binary_expression' ||
      child.type === 'unary_expression' ||
      child.type === 'ternary_expression' ||
      child.type === 'parenthesized_expression'
    ) {
      validateArithmetic(child, scope)
      continue
    }
    if (child.type === 'simple_expansion') {
      const nameNode = childOfKind(child, 'variable_name')
      if (nameNode && integerValued(scope.get(nameNode.text))) continue
      refuse(`arithmetic expression contains a non-literal term ${JSON.stringify(child.text.trim())}`, node.type)
    }
    refuseNode(child)
  }
}

export function heredocBody(node: Node): string {
  const start = childOfKind(node, 'heredoc_start')
  const quotedDelimiter =
    start !== undefined &&
    ((start.text.startsWith("'") && start.text.endsWith("'")) ||
      (start.text.startsWith('"') && start.text.endsWith('"')) ||
      start.text.startsWith('\\'))
  if (!quotedDelimiter) refuse('heredoc with an unquoted delimiter undergoes shell expansion', node.type)

  let body = ''
  for (const child of node.children) {
    if (
      child.type === '<<' ||
      child.type === '<<-' ||
      child.type === 'heredoc_start' ||
      child.type === 'heredoc_end' ||
      child.type === 'file_descriptor'
    ) {
      continue
    }
    if (child.type === 'heredoc_body') {
      for (const part of child.children) {
        if (part.type !== 'heredoc_content') refuseNode(part)
      }
      body += child.text
      continue
    }
    refuseNode(child)
  }
  return body
}

export function substitutionStatements(node: Node): Node[] {
  return node.children.filter((child: Node) => child.type !== '$(' && child.type !== ')' && child.type !== '`')
}

function asRedirectOp(token: string): Redirect['op'] | undefined {
  if (!REDIRECT_OPERATORS.has(token)) return undefined
  switch (token) {
    case '>':
    case '>>':
    case '<':
    case '>&':
    case '<&':
    case '>|':
    case '&>':
    case '&>>':
    case '<<<':
      return token
    default:
      return undefined
  }
}

function unquotedRedirectExpansion(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if ('*?[]~'.includes(text[index]!)) return true
  }
  return false
}

const REDIRECT_OPERATORS: ReadonlySet<string> = new Set(['>', '>>', '<', '>&', '<&', '>|', '&>', '&>>', '<<<'])

const PS4_SAFE_RE = /^[A-Za-z0-9 _+:./=[\]-]*$/
const PS4_REFERENCE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g

export type Assignment = { name: string; value: string; append: boolean }
type Quoted = { value: string; sawLiteral: boolean; sawUnknown: boolean }

const PIPELINE_STATUS_EXPANSION = /^\$\{(?:PIPESTATUS|pipestatus)\[[0-9]+\](?::-(?:\$\?|[A-Za-z0-9_-]+))?\}$/

function plainExpansion(node: Node): boolean {
  return node.type === 'expansion' && node.children.length === 3 && node.children[0]!.type === '${' && node.children[1]!.type === 'variable_name' && node.children[2]!.type === '}'
}

export const LOOKUP_VARIABLE = /^(?:PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELL|HOME|TMPDIR|PWD|OLDPWD|CDPATH|GLOBIGNORE|SHELLOPTS|BASHOPTS|NODE_OPTIONS|PYTHONPATH|NODE_PATH|RUBYOPT|PERL5OPT|GIT_CONFIG.*|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_PAGER|GIT_EXTERNAL_DIFF|GIT_DIR|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_NAMESPACE)$/

export abstract class WordWalk {
  abstract substitution(node: Node, scope: Scope): void

  heredocPrinting(node: Node): string | null {
    const inner = substitutionStatements(node)
    if (inner.length !== 1 || (inner[0] as Node).type !== 'redirected_statement') return null
    const statement = inner[0] as Node

    let commandNode: Node | undefined
    let heredocNode: Node | undefined
    for (const child of statement.children) {
      if (child.type === 'command') {
        if (commandNode) return null
        commandNode = child
      } else if (child.type === 'heredoc_redirect') {
        if (heredocNode) return null
        heredocNode = child
      } else {
        return null
      }
    }
    if (!commandNode || !heredocNode) return null
    if (commandNode.children.length !== 1) return null
    const nameNode = commandNode.children[0] as Node
    if (nameNode.type !== 'command_name' || nameNode.text !== 'cat') return null

    const body = heredocBody(heredocNode).replace(/\n+$/, '')
    if (PROCESS_ENVIRON_RE.test(body)) refuse('heredoc body references a process environment file', heredocNode.type)
    if (SYSTEM_CALL_RE.test(body)) refuse('heredoc body contains a system() call', heredocNode.type)
    return body
  }

  quoted(node: Node, scope: Scope, operand?: Operand): Quoted {
    let value = ''
    let sawLiteral = false
    let sawUnknown = false
    let sawContent = false

    for (let index = 0; index < node.children.length; index++) {
      const child = node.children[index]!
      if (child.type === '"') {
        if (index > 0 && child.text.length > 1) {
          const lead = child.text.slice(0, -1)
          value += lead
          sawLiteral = true
        }
        continue
      }
      sawContent = true
      if (child.type === 'string_content') {
        const text = unescapeQuoted(child.text)
        value += text
        if (text.length > 0) sawLiteral = true
        continue
      }
      if (child.type === '$') {
        value += unescapeQuoted(child.text)
        sawLiteral = true
        continue
      }
      if (child.type === 'command_substitution') {
        const trimmed = child.text.trimStart()
        value += child.text.slice(0, child.text.length - trimmed.length)
        const printed = this.heredocPrinting(child)
        if (printed !== null) {
          value += printed
          if (printed.length > 0) sawLiteral = true
        } else {
          this.substitution(child, scope)
          value += UNKNOWN_SUBSTITUTION
          sawUnknown = true
        }
        continue
      }
      if (child.type === 'expansion') {
        const trimmed = child.text.trimStart()
        value += child.text.slice(0, child.text.length - trimmed.length)
        if (PIPELINE_STATUS_EXPANSION.test(trimmed)) {
          value += UNKNOWN_VALUE
          sawUnknown = true
          continue
        }
        if (plainExpansion(child)) {
          const ref = reference(child, scope, true, operand)
          value += ref.value
          if (ref.unknown) sawUnknown = true
          else if (ref.value.length > 0) sawLiteral = true
          continue
        }
        refuseNode(child)
      }
      if (child.type === 'simple_expansion') {
        const trimmed = child.text.trimStart()
        value += child.text.slice(0, child.text.length - trimmed.length)
        const ref = reference(child, scope, true, operand)
        value += ref.value
        if (ref.unknown) sawUnknown = true
        else if (ref.value.length > 0) sawLiteral = true
        continue
      }
      if (child.type === 'arithmetic_expansion') {
        const trimmed = child.text.trimStart()
        value += child.text.slice(0, child.text.length - trimmed.length)
        validateArithmetic(child, scope)
        value += UNKNOWN_VALUE
        sawUnknown = true
        continue
      }
      refuseNode(child)
    }

    if (sawUnknown && !sawLiteral) {
      refuse('Bash needs approval for this variable-only argument because its value is unknown. Use its literal path or value.', node.type)
    }
    if (!sawContent && value === '' && node.text.length > 2) {
      refuse('whitespace-only quoted string cannot be analyzed faithfully', node.type)
    }
    return { value, sawLiteral, sawUnknown }
  }

  argument(node: Node | null | undefined, scope: Scope, operand?: Operand): string {
    if (!node) refuse('missing argument')
    switch (node.type) {
      case 'word':
        refuseBraceExpansion(node)
        if (unquotedWildcard(node.text)) {
          if (!operand) refuse(WILDCARD_REASON, node.type)
          operand.glob = true
        }
        return unescapeWord(node.text)
      case 'number':
        if (node.children.length > 0) {
          const embedded = node.children[0]!
          refuse(`number carries an embedded expansion (${embedded.type})`, embedded.type)
        }
        return node.text
      case 'raw_string':
        return node.text.slice(1, -1)
      case 'string':
        return this.quoted(node, scope, operand).value
      case 'concatenation': {
        refuseBraceExpansion(node)
        let out = ''
        for (const child of node.children) out += this.argument(child, scope, operand)
        return out
      }
      case 'arithmetic_expansion':
        validateArithmetic(node, scope)
        return UNKNOWN_VALUE
      case 'expansion':
        if (plainExpansion(node)) return reference(node, scope, false, operand).value
        refuseNode(node)
      case 'simple_expansion':
        return reference(node, scope, false, operand).value
      default:
        refuseNode(node)
    }
  }

  redirect(node: Node, scope: Scope): Redirect {
    let fd: number | undefined
    let op: Redirect['op'] | undefined
    let targetNode: Node | undefined

    for (const child of node.children) {
      if (child.type === 'file_descriptor') {
        fd = Number(child.text)
        continue
      }
      if (op === undefined) {
        const parsedOp = asRedirectOp(child.type)
        if (parsedOp !== undefined) {
          op = parsedOp
          continue
        }
      }
      if (targetNode === undefined) {
        targetNode = child
        continue
      }
      refuse('a redirect is followed by additional words whose argument position is ambiguous; move arguments before the redirect, or approve', node.type)
    }

    if (op === undefined || targetNode === undefined) refuse('unrecognised redirect shape', node.type)

    let target: string
    switch (targetNode.type) {
      case 'word':
        refuseBraceExpansion(targetNode)
        if (unquotedRedirectExpansion(targetNode.text)) {
          refuse('the redirect target contains an unquoted path expansion; spell out the path, or approve', node.type)
        }
        target = unescapeWord(targetNode.text)
        break
      case 'number':
      case 'raw_string':
      case 'string':
        target = this.argument(targetNode, scope)
        break
      case 'concatenation':
        refuseBraceExpansion(targetNode)
        for (const part of targetNode.children) {
          if (part.type === 'word' && unquotedRedirectExpansion(part.text)) {
            refuse('the redirect target contains an unquoted path expansion; spell out the path, or approve', node.type)
          }
        }
        target = this.argument(targetNode, scope)
        break
      default:
        refuseNode(targetNode)
    }

    return fd === undefined ? { op, target } : { op, target, fd }
  }

  assignment(node: Node, scope: Scope): Assignment {
    let nameNode: Node | undefined
    let append = false
    let valueNode: Node | undefined
    let seenOp = false

    for (const child of node.children) {
      if (!seenOp && child.type === 'variable_name' && nameNode === undefined) {
        nameNode = child
      } else if (!seenOp && (child.type === '=' || child.type === '+=')) {
        append = child.type === '+='
        seenOp = true
      } else if (!seenOp) {
        refuseNode(child)
      } else {
        valueNode = child
      }
    }

    if (!nameNode) refuse('variable assignment has no name', node.type)
    const name = nameNode.text
    if (!IDENTIFIER_RE.test(name)) {
      refuse(`assignment name ${JSON.stringify(name)} is not a valid shell identifier`, node.type)
    }
    if (LOOKUP_VARIABLE.test(name)) {
      refuse(`assignment to ${name} changes shell lookup, path expansion or startup code; run without that assignment, or approve`, node.type)
    }
    if (name === 'IFS') refuse('assignment to IFS cannot be analyzed safely', node.type)

    let value = ''
    if (valueNode !== undefined) {
      if (valueNode.type === 'command_substitution') {
        const printed = this.heredocPrinting(valueNode)
        if (printed !== null) {
          value = printed
        } else {
          this.substitution(valueNode, scope)
          value = UNKNOWN_SUBSTITUTION
        }
      } else if (valueNode.type === 'arithmetic_expansion') {
        validateArithmetic(valueNode, scope)
        value = UNKNOWN_INTEGER
      } else if (valueNode.type === 'simple_expansion' || plainExpansion(valueNode)) {
        value = reference(valueNode, scope, true).value
      } else {
        value = this.argument(valueNode, scope)
      }
    }

    if (name === 'PS4') {
      if (append) refuse('appending to PS4 cannot be analyzed safely', node.type)
      if (!isKnown(value)) refuse('PS4 value derived at runtime cannot be analyzed safely', node.type)
      if (!PS4_SAFE_RE.test(value.replace(PS4_REFERENCE_RE, ''))) {
        refuse('PS4 value contains characters outside the safe trace-prefix set', node.type)
      }
    }

    if (value.includes('~')) {
      refuse('assignment value contains ~, which the shell may expand at assignment time', node.type)
    }

    return { name, value, append }
  }
}
