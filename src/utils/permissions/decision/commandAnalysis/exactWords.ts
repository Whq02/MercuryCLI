import { misreadWordList, type Node, type WordListFault } from '../../../bash/parser.js'
import type { Redirect } from './reading.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../../../pi/holes.js'

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
  return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:69')
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

const ARITHMETIC_INTEGER_RE: Unbuilt = unbuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:147')

export function heredocBody(node: Node): string {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:176')
}

export function substitutionStatements(node: Node): Node[] {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:206')
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
    return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:258')
  }

  argument(node: Node | null | undefined, scope: Scope, operand?: Operand): string {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:335')
  }

  redirect(node: Node, scope: Scope): Redirect {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:374')
  }

  assignment(node: Node, scope: Scope): Assignment {
    return notBuilt('src/utils/permissions/decision/commandAnalysis/exactWords.ts:415')
  }
}
