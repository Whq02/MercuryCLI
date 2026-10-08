import { SHELL_KEYWORDS } from './bashParser.js'
import { PARSE_ABORTED, parseCommandRaw, preparedCommandRoot, type Node } from './parser.js'

export type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

export type SimpleCommand = {
  argv: string[]
  envVars: { name: string; value: string }[]
  redirects: Redirect[]
  text: string
}

export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

type SemanticCheckResult = { ok: true } | { ok: false; reason: string }
const preparedSimpleCommands = new Map<string, WeakRef<SimpleCommand>>()
const reclaimedCommands = new FinalizationRegistry<{ text: string; reference: WeakRef<SimpleCommand> }>(({ text, reference }) => {
  if (preparedSimpleCommands.get(text) === reference) preparedSimpleCommands.delete(text)
})

export function preparedSimpleCommand(text: string): SimpleCommand | null {
  return preparedSimpleCommands.get(text)?.deref() ?? null
}

function rememberCommands(commands: SimpleCommand[]): void {
  for (const command of commands) {
    const reference = new WeakRef(command)
    for (const text of new Set([command.text, command.argv.map(quoteArgv).join(' ')])) {
      preparedSimpleCommands.set(text, reference)
      reclaimedCommands.register(command, { text, reference })
    }
  }
}

export function preparedSecurityParse(command: string): ParseForSecurityResult {
  const root = preparedCommandRoot(command)
  if (root) return parseForSecurityFromAst(command, root)
  const simple = preparedSimpleCommand(command)
  return simple ? { kind: 'simple', commands: [simple] } : { kind: 'parse-unavailable' }
}

class Refusal {
  constructor(
    readonly reason: string,
    readonly nodeType?: string,
  ) {}
}

function refuse(reason: string, nodeType?: string): never {
  throw new Refusal(reason, nodeType)
}

const REFUSED_KINDS: readonly string[] = [
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'brace_expression',
  'subshell',
  'compound_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'if_statement',
  'case_statement',
  'function_definition',
  'test_command',
  'ansi_c_string',
  'translated_string',
  'herestring_redirect',
  'heredoc_redirect',
]

function refuseNode(node: Node): never {
  if (node.type === 'ERROR') refuse('the shell parser found incomplete or invalid syntax; fix the quotes or operators, or approve', node.type)
  if (node.type === 'command_substitution') refuse('a command substitution supplies an argument at runtime; spell out its value or run the inner command separately, or approve', node.type)
  if (node.type === 'process_substitution') refuse('a process substitution starts another command; run that command separately, or approve', node.type)
  if (node.type === 'simple_expansion' || node.type === 'expansion') refuse(`the expansion ${JSON.stringify(node.text)} supplies a value at runtime; spell out the value, or approve`, node.type)
  const construct = node.type.replaceAll('_', ' ')
  refuse(`the shell parser cannot establish the effect of this ${construct}; split it into explicit commands, or approve`, node.type)
}

const UNKNOWN_SUBSTITUTION = '__MERCURY_UNKNOWN_SUBSTITUTION__'
const UNKNOWN_VALUE = '__MERCURY_UNKNOWN_VALUE__'

function isKnown(value: string): boolean {
  return !value.includes(UNKNOWN_SUBSTITUTION) && !value.includes(UNKNOWN_VALUE)
}

type Scope = Map<string, string>

function appended(existing: string, added: string): string {
  if (!isKnown(existing) || !isKnown(added)) return UNKNOWN_VALUE
  return existing + added
}

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

const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/
const UNICODE_WHITESPACE_RE = /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/
const ESCAPED_BLANK_RE = /\\[ \t]/
const MIDWORD_CONTINUATION_RE = /[^ \t\n\\]\\\n/
const ZSH_EQUALS_EXPANSION_RE = /(^|[ \t\n;&|])=[A-Za-z_]/
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
  [command => CONTROL_CHARACTER_RE.test(command), 'Contains control characters'],
  [command => UNICODE_WHITESPACE_RE.test(command), 'Contains invisible Unicode whitespace characters'],
  [
    command => ESCAPED_BLANK_RE.test(command) || MIDWORD_CONTINUATION_RE.test(command),
    'Contains backslash-escaped whitespace, which the shell and the parser tokenize differently',
  ],
  [command => command.includes('~['), 'Contains zsh dynamic named directory syntax (~[), which can run arbitrary code'],
  [command => ZSH_EQUALS_EXPANSION_RE.test(command), 'Contains word-initial = expansion, which zsh rewrites to a command path'],
  [
    command => command.includes('{') && BRACE_WITH_QUOTE_RE.test(maskQuotedBraces(command)),
    'Contains brace expansion with embedded quotes, which can hide the expanded command',
  ],
]

function preCheckReason(command: string): string | null {
  for (const [trips, reason] of PRE_CHECKS) if (trips(command)) return reason
  return null
}

function childOfKind(node: Node, kind: string): Node | undefined {
  return node.children.find(child => child.type === kind)
}

const BRACE_EXPANSION_RE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/

function refuseBraceExpansion(node: Node): void {
  if (BRACE_EXPANSION_RE.test(node.text)) refuse('contains brace expansion syntax', node.type)
}

function unescapeWord(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

function unescapeQuoted(text: string): string {
  return text.replace(/\\([$`"\\])/g, '$1')
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const NEWLINE_COMMENT_RE = /\n[ \t]*#/
const PROCESS_ENVIRON_RE = /\/proc\/.*\/environ/
const SYSTEM_CALL_RE = /\bsystem\s*\(/

type Reference = { value: string; unknown: boolean }

function reference(node: Node, scope: Scope, insideString: boolean): Reference {
  const nameNode = childOfKind(node, 'variable_name') ?? childOfKind(node, 'special_variable_name')
  if (!nameNode) refuse('variable reference has no name', node.type)
  const name = nameNode.text

  if (scope.has(name)) {
    const tracked = scope.get(name) as string
    if (!isKnown(tracked)) {
      if (insideString) return { value: tracked, unknown: true }
      refuse(`value of $${name} is not statically known`, node.type)
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

function arithmetic(node: Node): void {
  for (const child of node.children) {
    if (child.children.length === 0) {
      const text = child.text
      if (text === '$((' || ARITHMETIC_INTEGER_RE.test(text) || ARITHMETIC_OPERATORS_RE.test(text)) continue
      refuse(`arithmetic expression contains a non-literal term ${JSON.stringify(text)}`, node.type)
    }
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression':
        arithmetic(child)
        break
      default:
        refuseNode(child)
    }
  }
}

function heredocBody(node: Node): string {
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

function substitutionStatements(node: Node): Node[] {
  return node.children.filter(child => child.type !== '$(' && child.type !== ')' && child.type !== '`')
}

const DOLLAR_REFERENCE_RE = /\$[A-Za-z_]/
const NEEDS_QUOTING_RE = /["'\\ \t\n$`;|&<>(){}*?[\]~#]/

function quoteArgv(element: string): string {
  if (element !== '' && !NEEDS_QUOTING_RE.test(element)) return element
  return `'${element.replace(/'/g, "'\\''")}'`
}

export function shellCommandText(argv: string[]): string {
  return argv.map(quoteArgv).join(' ')
}

function commandText(span: string, argv: string[]): string {
  if (DOLLAR_REFERENCE_RE.test(span) || span.includes('\n')) return argv.map(quoteArgv).join(' ')
  return span
}

const REDIRECT_OPERATORS: ReadonlySet<string> = new Set(['>', '>>', '<', '>&', '<&', '>|', '&>', '&>>', '<<<'])

const DECLARATION_WORDS: ReadonlySet<string> = new Set(['export', 'local', 'readonly', 'declare', 'typeset'])
const SUBSCRIPT_DECLARATIONS: ReadonlySet<string> = new Set(['declare', 'typeset', 'local'])

const TEST_TOKENS: ReadonlySet<string> = new Set(['!', '(', ')', '&&', '||', '==', '=', '!=', '<', '>', '=~'])

const REDIRECTABLE: ReadonlySet<string> = new Set([
  'command',
  'pipeline',
  'list',
  'negated_command',
  'declaration_command',
  'unset_command',
])

const PS4_SAFE_RE = /^[A-Za-z0-9 _+:./=[\]-]*$/
const PS4_REFERENCE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g

type Assignment = { name: string; value: string; append: boolean }
type Quoted = { value: string; sawLiteral: boolean; sawUnknown: boolean }

function assign(scope: Scope, assignment: Assignment): void {
  if (assignment.append) {
    scope.set(assignment.name, appended(scope.get(assignment.name) ?? '', assignment.value))
  } else {
    scope.set(assignment.name, assignment.value)
  }
}

const VARIABLE_WRITERS: ReadonlySet<string> = new Set(['read', 'printf', 'getopts', 'wait'])
const LOOKUP_VARIABLE = /^(?:PATH|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELL|HOME|TMPDIR|PWD|OLDPWD|CDPATH|GLOBIGNORE|SHELLOPTS|BASHOPTS|NODE_OPTIONS|PYTHONPATH|NODE_PATH|RUBYOPT|PERL5OPT|GIT_CONFIG.*|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_ASKPASS|GIT_PAGER|GIT_EXTERNAL_DIFF|GIT_DIR|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_NAMESPACE)$/

function writtenVariables(argv: string[]): string[] {
  let words = argv
  while (words[0] === 'time') words = words.slice(words[1] === '-p' ? 2 : 1)
  const name = words[0]
  if (name === undefined || !VARIABLE_WRITERS.has(name)) return []
  const written: string[] = []
  const operands = words.slice(1)
  if (name === 'read' || name === 'wait') {
    let i = 0
    while (i < operands.length) {
      const operand = operands[i] as string
      if (operand === '--' || !operand.startsWith('-') || operand === '-') {
        if (name === 'read') written.push(...operands.slice(i + (operand === '--' ? 1 : 0)))
        break
      }
      for (let flag = 1; flag < operand.length; flag++) {
        const letter = operand[flag]!
        if (!(name === 'read' ? READ_DATA_FLAGS.has(letter) || letter === 'a' : letter === 'p')) continue
        const value = operand.slice(flag + 1) || operands[++i]
        if ((name === 'read' ? letter === 'a' : letter === 'p') && value !== undefined) written.push(value)
        break
      }
      i += 1
    }
    if (name === 'read' && written.length === 0) written.push('REPLY')
  }
  if (name === 'printf') {
    for (let i = 0; i < operands.length; i++) {
      const operand = operands[i] as string
      if (operand === '-v' && operands[i + 1] !== undefined) written.push(operands[i + 1] as string)
      else if (operand.startsWith('-v') && operand.length > 2) written.push(operand.slice(2))
    }
  }
  if (name === 'getopts') {
    if (operands[1] !== undefined) written.push(operands[1])
    written.push('OPTARG', 'OPTIND')
  }
  return written.map(variable => variable.replace(/\[.*$/, '')).filter(variable => IDENTIFIER_RE.test(variable))
}

class Walk {
  readonly commands: SimpleCommand[] = []

  invalidateAssignments(node: Node, scope: Scope): void {
    if (node.type === 'subshell' || node.type === 'command_substitution') return
    if (node.type === 'variable_assignment') {
      const name = childOfKind(node, 'variable_name')?.text
      if (name !== undefined) scope.set(name, UNKNOWN_VALUE)
    }
    if (node.type === 'command') {
      const changed = new Map(scope)
      try {
        new Walk().command(node, changed)
        for (const [name, value] of changed) {
          if (value !== scope.get(name)) scope.set(name, UNKNOWN_VALUE)
        }
      } catch (error) {
        if (!(error instanceof Refusal)) throw error
        for (const name of scope.keys()) scope.set(name, UNKNOWN_VALUE)
      }
    }
    for (const child of node.children) this.invalidateAssignments(child, scope)
  }

  node(node: Node, scope: Scope): void {
    switch (node.type) {
      case 'program':
      case 'list':
        this.statements(node.children, scope)
        return
      case 'pipeline':
        this.pipeline(node, scope)
        return
      case 'comment':
        return
      case 'command':
        this.command(node, scope)
        return
      case 'redirected_statement':
        this.redirected(node, scope)
        return
      case 'negated_command':
        for (const child of node.children) {
          if (child.type === '!') continue
          this.node(child, scope)
          return
        }
        return
      case 'declaration_command':
        this.declaration(node, scope)
        return
      case 'variable_assignment':
        assign(scope, this.assignment(node, scope))
        return
      case 'for_statement':
        this.loop(node, scope)
        return
      case 'if_statement':
        this.conditional(node, scope)
        return
      case 'while_statement':
        this.whileLoop(node, scope)
        return
      case 'subshell':
        this.subshell(node, scope)
        return
      case 'test_command':
        this.test(node, scope)
        return
      case 'unset_command':
        this.unset(node, scope)
        return
      default:
        refuseNode(node)
    }
  }

  statements(children: Node[], scope: Scope): void {
    const forks = children.some(child => child.type === '||' || child.type === '&&')
    const snapshot = forks ? new Map(scope) : null
    let current = scope
    for (const child of children) {
      switch (child.type) {
        case '&&':
          current = new Map(current)
          break
        case ';':
        case '\n':
          break
        case '&':
          refuse('the background operator & starts work outside the foreground command; run it in the foreground, or approve', child.type)
        case '||':
          current = new Map(snapshot as Scope)
          for (const branch of children) this.invalidateAssignments(branch, current)
          break
        default:
          this.node(child, current)
      }
    }
    if (forks) for (const child of children) this.invalidateAssignments(child, scope)
  }

  pipeline(node: Node, scope: Scope): void {
    let current = new Map(scope)
    for (const child of node.children) {
      if (child.type === '|' || child.type === '|&') {
        current = new Map(scope)
        continue
      }
      if (child.type === '\n') continue
      this.node(child, current)
    }
  }

  subshell(node: Node, scope: Scope): void {
    const inner = new Map(scope)
    const statements: Node[] = []
    for (const child of node.children) {
      if (child.type === '(' || child.type === ')') continue
      if (child.type === ';' || child.type === '&') refuseNode(child)
      statements.push(child)
    }
    this.statements(statements, inner)
  }

  substitution(node: Node, scope: Scope): void {
    this.statements(substitutionStatements(node), new Map(scope))
  }

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

  quoted(node: Node, scope: Scope): Quoted {
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
        case 'simple_expansion': {
          const resolved = reference(child, scope, true)
          value += resolved.value
          if (resolved.unknown) sawUnknown = true
          else sawLiteral = true
          break
        }
        case 'arithmetic_expansion':
          arithmetic(child)
          value += UNKNOWN_VALUE
          sawUnknown = true
          break
        default:
          refuseNode(child)
      }
      cursor = child.endIndex
    }

    if (sawUnknown && !sawLiteral) {
      refuse('quoted argument consists entirely of runtime-determined content', node.type)
    }
    if (!sawLiteral && !sawUnknown && node.text.length > 2) {
      refuse('whitespace-only quoted string cannot be analyzed faithfully', node.type)
    }
    return { value, sawLiteral, sawUnknown }
  }

  argument(node: Node | null | undefined, scope: Scope): string {
    if (!node) refuse('missing argument node')
    switch (node.type) {
      case 'word':
        refuseBraceExpansion(node)
        for (let index = 0; index < node.text.length; index++) {
          if (node.text[index] === '\\') { index++; continue }
          if ('*?['.includes(node.text[index]!)) refuse('an unquoted wildcard expands to paths at runtime; quote it as text or spell out the paths, or approve', node.type)
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
        return this.quoted(node, scope).value
      case 'concatenation': {
        refuseBraceExpansion(node)
        let value = ''
        for (const child of node.children) value += this.argument(child, scope)
        return value
      }
      case 'arithmetic_expansion':
        arithmetic(node)
        return UNKNOWN_VALUE
      case 'simple_expansion':
        return reference(node, scope, false).value
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

  command(node: Node, scope: Scope): void {
    const argv: string[] = []
    const envVars: { name: string; value: string }[] = []
    const redirects: Redirect[] = []

    for (const child of node.children) {
      switch (child.type) {
        case 'variable_assignment': {
          const assignment = this.assignment(child, scope)
          envVars.push({ name: assignment.name, value: assignment.value })
          break
        }
        case 'command_name': {
          const inner = child.children.length > 0 ? (child.children[0] as Node) : child
          argv.push(this.argument(inner, scope))
          break
        }
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation':
        case 'arithmetic_expansion':
        case 'simple_expansion':
          argv.push(this.argument(child, scope))
          break
        case 'file_redirect':
          redirects.push(this.redirect(child, scope))
          break
        case 'command_substitution':
          if (argv[0] === 'rm' && argv.slice(1).some(arg => arg === '--recursive' || /^-[^-]*[rR]/.test(arg))) {
            refuse('a command substitution feeds a recursive delete; run it with the path spelled out, or approve', child.type)
          }
          refuseNode(child)
        case 'herestring_redirect':
          for (const part of child.children) {
            if (part.type === 'file_descriptor') refuseNode(part)
            if (part.type === '<<<') continue
            if (NEWLINE_COMMENT_RE.test(this.argument(part, scope))) {
              refuse('here-string content contains a newline followed by a comment', child.type)
            }
          }
          break
        default:
          refuseNode(child)
      }
    }

    this.commands.push({ argv, envVars, redirects, text: commandText(node.text, argv) })
    for (const name of writtenVariables(argv)) {
      if (LOOKUP_VARIABLE.test(name) || name === 'IFS' || name === 'PS4') {
        refuse(`${argv[0]} writes ${name}, changing shell lookup or expansion; use a different variable, or approve`, node.type)
      }
      scope.set(name, UNKNOWN_VALUE)
    }
  }

  declaration(node: Node, scope: Scope): void {
    const argv: string[] = []

    for (const child of node.children) {
      if (argv.length === 0 && DECLARATION_WORDS.has(child.type)) {
        argv.push(child.text)
        continue
      }
      switch (child.type) {
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation': {
          const resolved = this.argument(child, scope)
          if (SUBSCRIPT_DECLARATIONS.has(argv[0] ?? '')) {
            if (resolved.startsWith('-')) {
              const letters = /^-([A-Za-z]*)/.exec(resolved)?.[1] ?? ''
              if (/[niaA]/.test(letters)) {
                refuse(`declaration flag ${JSON.stringify(resolved)} creates a nameref, integer or array variable`, node.type)
              }
              if (/[luc]/.test(letters)) {
                refuse(`declaration flag ${JSON.stringify(resolved)} rewrites the case of the values it declares, so a tracked value no longer names what runs; drop the flag, or approve`, node.type)
              }
            } else {
              const bracket = resolved.indexOf('[')
              const equals = resolved.indexOf('=')
              if (bracket !== -1 && (equals === -1 || bracket < equals)) {
                refuse(`declaration operand ${JSON.stringify(resolved)} carries an array subscript`, node.type)
              }
            }
          }
          argv.push(resolved)
          break
        }
        case 'variable_assignment': {
          const assignment = this.assignment(child, scope)
          assign(scope, assignment)
          argv.push(`${assignment.name}=${assignment.value}`)
          break
        }
        case 'variable_name':
          argv.push(child.text)
          break
        default:
          refuseNode(child)
      }
    }

    this.commands.push({ argv, envVars: [], redirects: [], text: node.text })
  }

  unset(node: Node, scope: Scope): void {
    const argv: string[] = []
    for (const child of node.children) {
      if (argv.length === 0 && (child.type === 'unset' || child.type === 'unsetenv')) {
        argv.push(child.text)
        continue
      }
      switch (child.type) {
        case 'variable_name':
          argv.push(child.text)
          scope.delete(child.text)
          break
        case 'word':
          argv.push(this.argument(child, scope))
          break
        default:
          refuseNode(child)
      }
    }
    this.commands.push({ argv, envVars: [], redirects: [], text: node.text })
  }

  test(node: Node, scope: Scope): void {
    const argv: string[] = ['[[']
    const expression = (expr: Node): void => {
      switch (expr.type) {
        case 'binary_expression':
        case 'unary_expression':
        case 'parenthesized_expression':
        case 'negated_command':
          for (const child of expr.children) expression(child)
          return
        case 'test_operator':
        case 'regex':
        case 'extglob_pattern':
          argv.push(expr.text)
          return
        default:
          if (TEST_TOKENS.has(expr.type)) {
            argv.push(expr.text)
            return
          }
          argv.push(this.argument(expr, scope))
      }
    }
    for (const child of node.children) {
      if (child.type === '[[' || child.type === ']]' || child.type === '[' || child.type === ']') continue
      expression(child)
    }
    this.commands.push({ argv, envVars: [], redirects: [], text: node.text })
  }

  redirected(node: Node, scope: Scope): void {
    const redirects: Redirect[] = []
    let inner: Node | null = null

    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        redirects.push(this.redirect(child, scope))
        continue
      }
      if (child.type === 'heredoc_redirect') {
        heredocBody(child)
        continue
      }
      if (REDIRECTABLE.has(child.type)) {
        inner = child
        continue
      }
      refuseNode(child)
    }

    if (!inner) {
      this.commands.push({ argv: [], envVars: [], redirects, text: node.text })
      return
    }

    const before = this.commands.length
    this.node(inner, scope)
    if (this.commands.length > before && redirects.length > 0) {
      const last = this.commands[this.commands.length - 1] as SimpleCommand
      last.redirects.push(...redirects)
    }
  }

  loop(node: Node, scope: Scope): void {
    let variable: string | null = null
    let body: Node | null = null

    for (const child of node.children) {
      switch (child.type) {
        case 'for':
        case 'select':
        case 'in':
        case ';':
          break
        case 'variable_name':
          variable = child.text
          break
        case 'do_group':
          body = child
          break
        case 'command_substitution':
          this.substitution(child, scope)
          break
        default:
          this.argument(child, scope)
          break
      }
    }

    if (variable === null || body === null) refuse('loop is missing its variable or body', node.type)
    if (variable === 'IFS' || variable === 'PS4') refuse(`loop variable ${variable} cannot be analyzed safely`, node.type)

    this.invalidateAssignments(body, scope)
    scope.set(variable, UNKNOWN_VALUE)
    this.body(body, new Map(scope))
  }

  body(group: Node, scope: Scope): void {
    for (const statement of group.children) {
      if (statement.type === 'do' || statement.type === 'done' || statement.type === ';') continue
      this.node(statement, scope)
    }
  }

  conditional(node: Node, scope: Scope): void {
    let seenThen = false
    let thenScope: Scope | undefined

    for (const child of node.children) {
      switch (child.type) {
        case 'if':
        case 'fi':
        case ';':
          break
        case 'then':
          seenThen = true
          thenScope = new Map(scope)
          break
        case 'elif_clause':
        case 'else_clause': {
          const clauseScope = new Map(scope)
          for (const statement of child.children) {
            switch (statement.type) {
              case 'elif':
              case 'else':
              case 'then':
              case ';':
                break
              default:
                this.node(statement, clauseScope)
            }
          }
          break
        }
        default:
          if (!seenThen) this.node(child, scope)
          else this.node(child, thenScope!)
      }
    }
    this.invalidateAssignments(node, scope)
  }

  whileLoop(node: Node, scope: Scope): void {
    this.invalidateAssignments(node, scope)
    for (const child of node.children) {
      switch (child.type) {
        case 'while':
        case 'until':
        case ';':
          break
        case 'do_group':
          this.body(child, new Map(scope))
          break
        default:
          this.node(child, scope)
      }
    }
    this.invalidateAssignments(node, scope)
  }
}

const ABORT_KIND = 'PARSE_ABORT'
const ABORT_REASON = 'the shell parser did not finish reading this command; split it into simpler commands, or approve'

function settle(command: string, root: Node | typeof PARSE_ABORTED): SimpleCommand[] {
  const preCheck = preCheckReason(command)
  if (preCheck !== null) refuse(preCheck)
  if (command.trim() === '') return []
  if (root === PARSE_ABORTED) refuse(ABORT_REASON, ABORT_KIND)
  const walk = new Walk()
  walk.node(root, new Map())
  return walk.commands
}

function verdictOf(refusal: Refusal): ParseForSecurityResult {
  if (refusal.nodeType === undefined) return { kind: 'too-complex', reason: refusal.reason }
  return { kind: 'too-complex', reason: refusal.reason, nodeType: refusal.nodeType }
}

export function parseForSecurityFromAst(command: string, root: Node | typeof PARSE_ABORTED): ParseForSecurityResult {
  try {
    return { kind: 'simple', commands: settle(command, root) }
  } catch (error) {
    if (error instanceof Refusal) return verdictOf(error)
    return {
      kind: 'too-complex',
      reason: `analysis failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function parseForSecurity(command: string): Promise<ParseForSecurityResult> {
  if (command === '') return { kind: 'simple', commands: [] }
  const root = await parseCommandRaw(command)
  if (root === null) return { kind: 'parse-unavailable' }
  const result = parseForSecurityFromAst(command, root)
  if (result.kind === 'simple') rememberCommands(result.commands)
  return result
}

const SUBSCRIPT_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ['test', ['-v', '-R']],
  ['[', ['-v', '-R']],
  ['[[', ['-v', '-R']],
  ['printf', ['-v']],
  ['read', ['-a']],
  ['unset', ['-v']],
  ['wait', ['-p']],
])

const ARITHMETIC_COMPARISONS: ReadonlySet<string> = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge'])

const READ_DATA_FLAGS: ReadonlySet<string> = new Set(['p', 'd', 'n', 'N', 't', 'u', 'i'])

const ZSH_MODULE_BUILTINS: ReadonlySet<string> = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

const EVALUATING_BUILTINS: ReadonlySet<string> = new Set([
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'fc',
  'coproc',
  'noglob',
  'nocorrect',
  'trap',
  'enable',
  'mapfile',
  'readarray',
  'hash',
  'bind',
  'complete',
  'compgen',
  'alias',
  'let',
])

const JQ_SHORT_FILE_FLAG_RE = /^-(?:f|L)(?:$|[^A-Za-z])/
const JQ_LONG_FILE_FLAG_RE = /^--(?:from-file|rawfile|slurpfile|library-path)(?:$|=)/

const TIMEOUT_DURATION_RE = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/
const TIMEOUT_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

type Peeled = string[] | { failReason: string } | null

const WRAPPERS: ReadonlyMap<string, (argv: string[]) => Peeled> = new Map([
  ['time', argv => argv.slice(1)],
  ['nohup', argv => argv.slice(1)],
  [
    'timeout',
    argv => {
      let i = 1
      while (i < argv.length) {
        const flag = argv[i] as string
        if (!flag.startsWith('-')) break
        if (flag === '--foreground' || flag === '--preserve-status' || flag === '--verbose') {
          i += 1
        } else if (flag.startsWith('--kill-after=') || flag.startsWith('--signal=')) {
          i += 1
        } else if (flag === '--kill-after' || flag === '--signal' || flag === '-k' || flag === '-s') {
          const value = argv[i + 1]
          if (value === undefined || !TIMEOUT_VALUE_RE.test(value)) {
            return { failReason: `unrecognised timeout flag ${JSON.stringify(flag)} hides the wrapped command` }
          }
          i += 2
        } else if (flag === '-v') {
          i += 1
        } else if ((flag.startsWith('-k') || flag.startsWith('-s')) && flag.length > 2 && TIMEOUT_VALUE_RE.test(flag.slice(2))) {
          i += 1
        } else {
          return { failReason: `unrecognised timeout flag ${JSON.stringify(flag)} hides the wrapped command` }
        }
      }
      if (i >= argv.length) return null
      const duration = argv[i] as string
      if (!TIMEOUT_DURATION_RE.test(duration)) {
        return { failReason: `unrecognised timeout duration ${JSON.stringify(duration)}` }
      }
      return argv.slice(i + 1)
    },
  ],
  [
    'nice',
    argv => {
      const first = argv[1]
      if (first === '-n' && argv[2] !== undefined && /^-?[0-9]+$/.test(argv[2])) return argv.slice(3)
      if (first !== undefined && /^-[0-9]+$/.test(first)) return argv.slice(2)
      if (first !== undefined && /[$(`]/.test(first)) {
        return { failReason: `unsafe nice argument ${JSON.stringify(first)}` }
      }
      return argv.slice(1)
    },
  ],
  [
    'env',
    argv => {
      let i = 1
      while (i < argv.length) {
        const arg = argv[i] as string
        if (arg.includes('=') && !arg.startsWith('-')) {
          i += 1
          continue
        }
        if (arg === '-i' || arg === '-0' || arg === '-v') {
          i += 1
          continue
        }
        if (arg === '-u') {
          if (i + 1 >= argv.length) {
            return { failReason: `unrecognised env flag ${JSON.stringify(arg)} hides the wrapped command` }
          }
          i += 2
          continue
        }
        if (arg.startsWith('-')) {
          return { failReason: `unrecognised env flag ${JSON.stringify(arg)} hides the wrapped command` }
        }
        break
      }
      if (i >= argv.length) return null
      return argv.slice(i)
    },
  ],
  [
    'stdbuf',
    argv => {
      let i = 1
      let consumed = false
      while (i < argv.length) {
        const arg = argv[i] as string
        if ((arg === '-i' || arg === '-o' || arg === '-e') && argv[i + 1] !== undefined) {
          i += 2
          consumed = true
          continue
        }
        if (/^-[ioe]./.test(arg) || /^--(?:input|output|error)=/.test(arg)) {
          i += 1
          consumed = true
          continue
        }
        if (arg.startsWith('-')) {
          return { failReason: `unrecognised stdbuf flag ${JSON.stringify(arg)} hides the wrapped command` }
        }
        break
      }
      if (!consumed || i >= argv.length) return null
      return argv.slice(i)
    },
  ],
])

export function peelWrappers(argv: string[]): string[] | { failReason: string } {
  let current = argv
  for (;;) {
    const peel = WRAPPERS.get(current[0] as string)
    if (peel === undefined) return current
    const peeled = peel(current)
    if (peeled === null) return current
    if (!Array.isArray(peeled)) return peeled
    current = peeled
  }
}

function readClusterTakesNext(cluster: string): boolean {
  for (let i = 1; i < cluster.length; i++) {
    if (READ_DATA_FLAGS.has(cluster[i] as string)) return i === cluster.length - 1
  }
  return false
}

type SemanticCheck = (name: string, argv: string[], command: SimpleCommand) => string | null

const emptyName: SemanticCheck = name =>
  name === '' ? 'command name is empty, so argv[0] may not reflect what the shell runs' : null

const runtimeName: SemanticCheck = name => (!isKnown(name) ? 'command name is determined at runtime' : null)

const fragmentName: SemanticCheck = name =>
  name.startsWith('-') || name.startsWith('|') || name.startsWith('&')
    ? `argv starts with the incomplete fragment ${JSON.stringify(name)}`
    : null

const subscriptOperands: SemanticCheck = (name, argv) => {
  const flags = SUBSCRIPT_FLAGS.get(name)
  if (flags === undefined) return null
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] as string
    const next = argv[i + 1]
    for (const flag of flags) {
      const letter = flag[1] as string
      const reason = `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
      if (arg === flag && next !== undefined && next.includes('[')) return reason
      if (
        arg.length > 2 &&
        arg.startsWith('-') &&
        arg[1] !== '-' &&
        !arg.includes('[') &&
        arg.slice(1).includes(letter) &&
        next !== undefined &&
        next.includes('[')
      ) {
        return reason
      }
      if (arg.startsWith(flag) && arg.length > 2 && arg.includes('[')) return reason
    }
  }
  return null
}

const arithmeticComparison: SemanticCheck = (name, argv) => {
  if (name !== '[[') return null
  for (let i = 2; i < argv.length; i++) {
    if (!ARITHMETIC_COMPARISONS.has(argv[i] as string)) continue
    const left = argv[i - 1] as string
    const right = argv[i + 1]
    if (left.includes('[') || (right !== undefined && right.includes('['))) {
      return 'arithmetic comparison inside [[ ]] evaluates bracketed subscripts, which can execute code'
    }
  }
  return null
}

const bareNameOperands: SemanticCheck = (name, argv) => {
  if (name !== 'read' && name !== 'unset') return null
  let i = 1
  while (i < argv.length) {
    const arg = argv[i] as string
    if (arg.startsWith('-')) {
      if (name === 'read' && readClusterTakesNext(arg)) i += 1
      i += 1
      continue
    }
    if (arg.includes('[')) {
      return `${name} with a bracketed name operand evaluates array subscripts, which can execute code`
    }
    i += 1
  }
  return null
}

const reservedName: SemanticCheck = name =>
  SHELL_KEYWORDS.has(name) ? `reserved word ${JSON.stringify(name)} as a command name indicates a mis-parsed command` : null

const newlineComment: SemanticCheck = (_name, _argv, command) => {
  for (const arg of command.argv) {
    if (NEWLINE_COMMENT_RE.test(arg)) {
      return 'a command argument contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  for (const envVar of command.envVars) {
    if (NEWLINE_COMMENT_RE.test(envVar.value)) {
      return 'an environment variable value contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  for (const redirect of command.redirects) {
    if (NEWLINE_COMMENT_RE.test(redirect.target)) {
      return 'a redirect target contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  return null
}

const jqProgram: SemanticCheck = (name, argv) => {
  if (name !== 'jq') return null
  for (const arg of argv) {
    if (SYSTEM_CALL_RE.test(arg)) return 'jq program contains a system() call, which executes arbitrary commands'
    if (JQ_SHORT_FILE_FLAG_RE.test(arg) || JQ_LONG_FILE_FLAG_RE.test(arg)) {
      return `jq flag ${JSON.stringify(arg)} enables code execution or arbitrary file reads`
    }
  }
  return null
}

const zshModule: SemanticCheck = name =>
  ZSH_MODULE_BUILTINS.has(name) ? `${name} is a zsh module builtin that can bypass security checks` : null

const evaluatingBuiltin: SemanticCheck = (name, argv) => {
  if (!EVALUATING_BUILTINS.has(name)) return null
  if (name === 'command') {
    if (argv[1] !== '-v' && argv[1] !== '-V') {
      return 'command bypasses function and alias lookup, so the effective target cannot be validated'
    }
    return null
  }
  if (name === 'fc') {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-') && !arg.startsWith('--') && /[es]/.test(arg)) {
        return 'fc in editor or re-execute mode runs the resulting command'
      }
    }
    return null
  }
  if (name === 'compgen') {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith('-') && !arg.startsWith('--') && /[CFW]/.test(arg)) {
        return 'compgen with -C, -F or -W executes code while generating completions'
      }
    }
    return null
  }
  return `${name} evaluates its arguments as shell code`
}

const processEnvironment: SemanticCheck = (_name, _argv, command) => {
  for (const arg of command.argv) {
    if (PROCESS_ENVIRON_RE.test(arg)) return 'references a process environment file, which may expose secrets'
  }
  for (const redirect of command.redirects) {
    if (PROCESS_ENVIRON_RE.test(redirect.target)) return 'redirects from a process environment file, which may expose secrets'
  }
  return null
}

const SEMANTIC_CHECKS: readonly SemanticCheck[] = [
  emptyName,
  runtimeName,
  fragmentName,
  subscriptOperands,
  arithmeticComparison,
  bareNameOperands,
  reservedName,
  newlineComment,
  jqProgram,
  zshModule,
  evaluatingBuiltin,
  processEnvironment,
]

function commandRefusal(command: SimpleCommand): string | null {
  const unknownArgument = command.argv.some((value, index) => !isKnown(value) && !(command.argv[0] === 'echo' && index > 0))
  if (unknownArgument || command.redirects.some(redirect => !isKnown(redirect.target))) {
    return 'an argument or redirect contains runtime-determined content; spell out its value, or approve'
  }
  const peeled = peelWrappers(command.argv)
  if (!Array.isArray(peeled)) return peeled.failReason
  const name = peeled[0]
  if (name === undefined) return null
  if (name === 'xargs' && peeled.length === 1) return 'bare xargs chooses its command implicitly; spell out the command, or approve'
  for (const check of SEMANTIC_CHECKS) {
    const reason = check(name, peeled, command)
    if (reason !== null) return reason
  }
  return null
}

export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const command of commands) {
    const reason = commandRefusal(command)
    if (reason !== null) return { ok: false, reason }
  }
  return { ok: true }
}

export function nodeTypeId(nodeType?: string): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const index = REFUSED_KINDS.indexOf(nodeType)
  return index === -1 ? 0 : index + 1
}
