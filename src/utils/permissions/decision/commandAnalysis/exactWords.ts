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
  return node.children.find(child => child.type === kind)
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

function reference(node: Node, scope: Scope, insideString: boolean, operand?: Operand): Reference {
  const nameNode = childOfKind(node, 'variable_name') ?? childOfKind(node, 'special_variable_name')
  if (!nameNode) refuse('variable reference has no name', node.type)
  const name = nameNode.text

  if (scope.has(name)) {
    const tracked = scope.get(name) as string
    if (tracked.startsWith(GLOB_ITEM)) {
      if (operand === undefined) refuse(WILDCARD_REASON, node.type)
      operand.glob = true
      return { value: tracked.slice(GLOB_ITEM.length), unknown: false }
    }
    if (!isKnown(tracked)) {
      if (node.type === 'expansion') refuseNode(node)
      if (insideString) return { value: tracked, unknown: true }
      refuse(`Bash needs approval for $${name} because its value is unknown. Use its literal path or value.`, node.type)
    }
    if (!insideString) {
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
  if (insideString) {
    if (SHELL_VARIABLES.has(name)) return { value: UNKNOWN_VALUE, unknown: true }
    if (nameNode.type === 'special_variable_name' && (SPECIAL_VARIABLES.has(name) || /^[0-9]+$/.test(name))) {
      return { value: UNKNOWN_VALUE, unknown: true }
    }
  }
  refuse(`reference to variable $${name} whose value is not statically known`, node.type)
}

const ARITHMETIC_INTEGER_RE = /^(?:[0-9]+|0[xX][0-9A-Fa-f]+|[0-9]+#[0-9A-Za-z]+)$/
const ARITHMETIC_OPERATORS_RE = /^[-+*/%^&|~!<>=?:(),]+$/

function arithmetic(node: Node, scope: Scope): void {
  for (const child of node.children) {
    if (child.children.length === 0) {
      const text = child.text
      if (text === '$((' || ARITHMETIC_INTEGER_RE.test(text) || ARITHMETIC_OPERATORS_RE.test(text)) continue
      if (child.type === 'variable_name' && integerValued(scope.get(text))) continue
      refuse(`arithmetic expression contains a non-literal term ${JSON.stringify(text)}`, node.type)
    }
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression':
        arithmetic(child, scope)
        break
      case 'simple_expansion': {
        const name = childOfKind(child, 'variable_name')?.text
        if (name !== undefined && integerValued(scope.get(name))) break
        refuse(`arithmetic expression contains a non-literal term ${JSON.stringify(child.text)}`, node.type)
      }
      default:
        refuseNode(child)
    }
  }
}

export function heredocBody(node: Node): string {
  const delimiter = childOfKind(node, 'heredoc_start')?.text ?? ''
  const quoted =
    (delimiter.startsWith("'") && delimiter.endsWith("'")) ||
    (delimiter.startsWith('"') && delimiter.endsWith('"')) ||
    delimiter.startsWith('\\')
  if (!quoted) refuse('heredoc with an unquoted delimiter undergoes shell expansion', node.type)

  let body = ''
  for (const child of node.children) {
    switch (child.type) {
      case '<<':
      case '<<-':
      case 'heredoc_start':
      case 'heredoc_end':
      case 'file_descriptor':
        break
      case 'heredoc_body':
        for (const bodyChild of child.children) {
          if (bodyChild.type !== 'heredoc_content') refuseNode(bodyChild)
        }
        body = child.text
        break
      default:
        refuseNode(child)
    }
  }
  return body
}

export function substitutionStatements(node: Node): Node[] {
  return node.children.filter(child => child.type !== '$(' && child.type !== ')' && child.type !== '`')
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
    let cursor: number | null = null

    const children = node.children
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Node
      if (cursor !== null && child.startIndex > cursor) {
        value += unescapeQuoted(node.text.slice(cursor - node.startIndex, child.startIndex - node.startIndex))
        sawLiteral = true
      }
      if (child.type === '"') {
        if (i > 0 && child.text.length > 1) {
          value += child.text.slice(0, -1)
          sawLiteral = true
        }
        cursor = child.endIndex
        continue
      }

      switch (child.type) {
        case 'string_content':
          value += unescapeQuoted(child.text)
          sawLiteral = true
          break
        case '$':
          value += '$'
          sawLiteral = true
          break
        case 'command_substitution': {
          const heredoc = this.heredocPrinting(child)
          if (heredoc !== null) {
            value += heredoc
            sawLiteral = true
          } else {
            this.substitution(child, scope)
            value += UNKNOWN_SUBSTITUTION
            sawUnknown = true
          }
          break
        }
        case 'expansion':
          if (PIPELINE_STATUS_EXPANSION.test(child.text)) {
            value += UNKNOWN_VALUE
            sawUnknown = true
            break
          }
          if (!plainExpansion(child)) refuseNode(child)
        case 'simple_expansion': {
          const resolved = reference(child, scope, true, operand)
          value += resolved.value
          if (resolved.unknown) sawUnknown = true
          else sawLiteral = true
          break
        }
        case 'arithmetic_expansion':
          arithmetic(child, scope)
          value += UNKNOWN_VALUE
          sawUnknown = true
          break
        default:
          refuseNode(child)
      }
      cursor = child.endIndex
    }

    if (sawUnknown && !sawLiteral) {
      refuse('Bash needs approval for this variable-only argument because its value is unknown. Use its literal path or value.', node.type)
    }
    if (!sawLiteral && !sawUnknown && node.text.length > 2) {
      refuse('whitespace-only quoted string cannot be analyzed faithfully', node.type)
    }
    return { value, sawLiteral, sawUnknown }
  }

  argument(node: Node | null | undefined, scope: Scope, operand?: Operand): string {
    if (!node) refuse('missing argument node')
    switch (node.type) {
      case 'word':
        refuseBraceExpansion(node)
        if (unquotedWildcard(node.text)) {
          if (operand === undefined) refuse(WILDCARD_REASON, node.type)
          operand.glob = true
        }
        return unescapeWord(node.text)
      case 'number':
        if (node.children.length > 0) {
          const child = node.children[0] as Node
          refuse(`number carries an embedded expansion (${child.type})`, child.type)
        }
        return node.text
      case 'raw_string':
        return node.text.slice(1, -1)
      case 'string':
        return this.quoted(node, scope, operand).value
      case 'concatenation': {
        refuseBraceExpansion(node)
        let value = ''
        for (const child of node.children) value += this.argument(child, scope, operand)
        return value
      }
      case 'arithmetic_expansion':
        arithmetic(node, scope)
        return UNKNOWN_VALUE
      case 'expansion':
        if (!plainExpansion(node)) refuseNode(node)
        return reference(node, scope, false, operand).value
      case 'simple_expansion':
        return reference(node, scope, false, operand).value
      default:
        refuseNode(node)
    }
  }

  redirect(node: Node, scope: Scope): Redirect {
    let fd: number | undefined
    let op: Redirect['op'] | undefined
    let target: string | undefined

    for (const child of node.children) {
      if (child.type === 'file_descriptor') {
        fd = Number.parseInt(child.text, 10)
        continue
      }
      if (op === undefined && REDIRECT_OPERATORS.has(child.type)) {
        op = child.type as Redirect['op']
        continue
      }
      if (target !== undefined) refuse('a redirect is followed by additional words whose argument position is ambiguous; move arguments before the redirect, or approve', node.type)
      switch (child.type) {
        case 'word':
        case 'number':
          if (child.children.length > 0) refuseNode(child.children[0] as Node)
          if (/[*?\[\]~]/.test(child.text)) refuse('the redirect target contains an unquoted path expansion; spell out the path, or approve', node.type)
          refuseBraceExpansion(child)
          target = unescapeWord(child.text)
          break
        case 'raw_string':
          target = child.text.slice(1, -1)
          break
        case 'string':
          target = this.quoted(child, scope).value
          break
        case 'concatenation':
          target = this.argument(child, scope)
          break
        default:
          refuseNode(child)
      }
    }

    if (op === undefined || target === undefined) refuse('unrecognised redirect shape', node.type)
    return fd === undefined ? { op, target } : { op, target, fd }
  }

  assignment(node: Node, scope: Scope): Assignment {
    let name: string | undefined
    let append = false
    let value = ''

    for (const child of node.children) {
      switch (child.type) {
        case 'variable_name':
          name = child.text
          break
        case '=':
          break
        case '+=':
          append = true
          break
        case 'command_substitution':
          this.substitution(child, scope)
          value = UNKNOWN_SUBSTITUTION
          break
        case 'arithmetic_expansion':
          arithmetic(child, scope)
          value = UNKNOWN_INTEGER
          break
        case 'expansion':
          if (!plainExpansion(child)) refuseNode(child)
        case 'simple_expansion':
          value = reference(child, scope, true).value
          break
        default:
          value = this.argument(child, scope)
          break
      }
    }

    if (name === undefined) refuse('variable assignment has no name', node.type)
    if (!IDENTIFIER_RE.test(name)) {
      refuse(`assignment name ${JSON.stringify(name)} is not a valid shell identifier`, node.type)
    }
    if (LOOKUP_VARIABLE.test(name)) {
      refuse(`assignment to ${name} changes shell lookup, path expansion or startup code; run without that assignment, or approve`, node.type)
    }
    if (name === 'IFS') refuse('assignment to IFS cannot be analyzed safely', node.type)
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
