import { SHELL_KEYWORDS } from './bashParser.js'
import { PARSE_ABORTED, parseCommandRaw, type Node } from './parser.js'


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

export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }


class TooComplexError extends Error {
  readonly reason: string
  readonly nodeType: string | undefined
  constructor(reason: string, nodeType?: string) {
    super(reason)
    this.name = 'TooComplexError'
    this.reason = reason
    this.nodeType = nodeType
  }
}

const DANGEROUS_NODE_TYPES: readonly string[] = [
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

function refusalForNode(node: Node): TooComplexError {
  if (node.type === 'ERROR') return new TooComplexError('parse error', node.type)
  if (DANGEROUS_NODE_TYPES.includes(node.type)) {
    return new TooComplexError(`contains ${node.type}`, node.type)
  }
  return new TooComplexError(`unhandled node type ${node.type}`, node.type)
}


const SUBSTITUTION_MARKER = '__MERCURY_UNKNOWN_SUBSTITUTION__'
const UNKNOWN_MARKER = '__MERCURY_UNKNOWN_VALUE__'

function isLiteralValue(value: string): boolean {
  return !value.includes(SUBSTITUTION_MARKER) && !value.includes(UNKNOWN_MARKER)
}

type VariableScope = Map<string, string>

function combineAppend(existing: string, added: string): string {
  if (!isLiteralValue(existing) || !isLiteralValue(added)) return UNKNOWN_MARKER
  return existing + added
}

const KNOWN_SHELL_VARIABLES: ReadonlySet<string> = new Set([
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

const ALLOWED_SPECIAL_VARIABLES: ReadonlySet<string> = new Set(['?', '$', '!', '#', '0', '-'])


const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/
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

function runPreChecks(command: string): string | null {
  if (CONTROL_CHARACTER_RE.test(command)) {
    return 'Contains control characters'
  }
  if (UNICODE_WHITESPACE_RE.test(command)) {
    return 'Contains invisible Unicode whitespace characters'
  }
  if (ESCAPED_BLANK_RE.test(command) || MIDWORD_CONTINUATION_RE.test(command)) {
    return 'Contains backslash-escaped whitespace, which the shell and the parser tokenize differently'
  }
  if (command.includes('~[')) {
    return 'Contains zsh dynamic named directory syntax (~[), which can run arbitrary code'
  }
  if (ZSH_EQUALS_EXPANSION_RE.test(command)) {
    return 'Contains word-initial = expansion, which zsh rewrites to a command path'
  }
  if (command.includes('{') && BRACE_WITH_QUOTE_RE.test(maskQuotedBraces(command))) {
    return 'Contains brace expansion with embedded quotes, which can hide the expanded command'
  }
  return null
}


function firstChildOfType(node: Node, type: string): Node | undefined {
  return node.children.find(child => child.type === type)
}

const BRACE_EXPANSION_RE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/

function refuseOnBraceExpansion(node: Node): void {
  if (BRACE_EXPANSION_RE.test(node.text)) {
    throw new TooComplexError('contains brace expansion syntax', node.type)
  }
}

function removeBackslashEscapes(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

function removeDoubleQuoteEscapes(text: string): string {
  return text.replace(/\\([$`"\\])/g, '$1')
}

const SHELL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const NEWLINE_THEN_COMMENT_RE = /\n[ \t]*#/

const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

const SYSTEM_CALL_RE = /\bsystem\s*\(/


type WalkContext = {
  commands: SimpleCommand[]
}


type ReferenceResolution = { value: string; unknown: boolean }

function resolveVariableReference(
  node: Node,
  scope: VariableScope,
  insideString: boolean,
): ReferenceResolution {
  const nameNode =
    firstChildOfType(node, 'variable_name') ?? firstChildOfType(node, 'special_variable_name')
  if (!nameNode) {
    throw new TooComplexError('variable reference has no name', node.type)
  }
  const name = nameNode.text

  if (scope.has(name)) {
    const tracked = scope.get(name) as string
    if (!isLiteralValue(tracked)) {
      if (insideString) return { value: tracked, unknown: true }
      throw new TooComplexError(
        `value of $${name} is not statically known`,
        node.type,
      )
    }
    if (!insideString) {
      if (tracked === '') {
        throw new TooComplexError(
          `$${name} is empty and the shell would drop the argument, shifting what actually runs`,
          node.type,
        )
      }
      if (/[ \t\n*?[]/.test(tracked)) {
        throw new TooComplexError(
          `value of $${name} would be word-split or glob-expanded into a different argv`,
          node.type,
        )
      }
    }
    return { value: tracked, unknown: false }
  }

  if (insideString) {
    if (KNOWN_SHELL_VARIABLES.has(name)) {
      return { value: UNKNOWN_MARKER, unknown: true }
    }
    if (
      nameNode.type === 'special_variable_name' &&
      (ALLOWED_SPECIAL_VARIABLES.has(name) || /^[0-9]+$/.test(name))
    ) {
      return { value: UNKNOWN_MARKER, unknown: true }
    }
  }
  throw new TooComplexError(
    `reference to variable $${name} whose value is not statically known`,
    node.type,
  )
}


const ARITH_INTEGER_RE = /^(?:[0-9]+|0[xX][0-9A-Fa-f]+|[0-9]+#[0-9A-Za-z]+)$/
const ARITH_OPERATOR_RUN_RE = /^[-+*/%^&|~!<>=?:(),]+$/

function validateArithmetic(node: Node): void {
  for (const child of node.children) {
    if (child.children.length === 0) {
      const text = child.text
      if (
        text === '$((' ||
        ARITH_INTEGER_RE.test(text) ||
        ARITH_OPERATOR_RUN_RE.test(text)
      ) {
        continue
      }
      throw new TooComplexError(
        `arithmetic expression contains a non-literal term ${JSON.stringify(text)}`,
        node.type,
      )
    }
    switch (child.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'ternary_expression':
      case 'parenthesized_expression':
        validateArithmetic(child)
        break
      default:
        throw refusalForNode(child)
    }
  }
}


function extractSubstitutionCommands(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const innerScope = new Map(scope)
  const statements = node.children.filter(
    child => child.type !== '$(' && child.type !== ')' && child.type !== '`',
  )
  walkStatementList(statements, innerScope, ctx)
}

function tryResolveHeredocPrintingSubstitution(node: Node): { text: string; dropped: boolean } | null {
  const inner = node.children.filter(
    child => child.type !== '$(' && child.type !== ')' && child.type !== '`',
  )
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

  const body = validateHeredocRedirect(heredocNode)

  const trimmed = body.replace(/\n+$/, '')

  if (PROC_ENVIRON_RE.test(trimmed)) {
    throw new TooComplexError(
      'heredoc body references a process environment file',
      heredocNode.type,
    )
  }
  if (SYSTEM_CALL_RE.test(trimmed)) {
    throw new TooComplexError('heredoc body contains a system() call', heredocNode.type)
  }

  if (trimmed.includes('\n')) {
    return { text: '', dropped: true }
  }
  return { text: trimmed, dropped: false }
}


function validateHeredocRedirect(node: Node): string {
  const start = firstChildOfType(node, 'heredoc_start')
  const delimiter = start?.text ?? ''
  const quoted =
    (delimiter.startsWith("'") && delimiter.endsWith("'")) ||
    (delimiter.startsWith('"') && delimiter.endsWith('"')) ||
    delimiter.startsWith('\\')
  if (!quoted) {
    throw new TooComplexError(
      'heredoc with an unquoted delimiter undergoes shell expansion',
      node.type,
    )
  }

  let body = ''
  for (const child of node.children) {
    switch (child.type) {
      case '<<':
      case '<<-':
      case 'heredoc_start':
      case 'heredoc_end':
      case 'file_descriptor':
        break
      case 'heredoc_body': {
        for (const bodyChild of child.children) {
          if (bodyChild.type !== 'heredoc_content') throw refusalForNode(bodyChild)
        }
        body = child.text
        break
      }
      default:
        throw refusalForNode(child)
    }
  }
  return body
}


type StringResolution = { value: string; sawLiteral: boolean; sawUnknown: boolean }

function resolveDoubleQuotedString(
  node: Node,
  scope: VariableScope,
  ctx: WalkContext,
): StringResolution {
  let value = ''
  let sawLiteral = false
  let sawUnknown = false
  let cursor: number | null = null

  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Node
    if (child.type === '"') {
      if (i === 0) cursor = child.endIndex
      continue
    }
    if (cursor !== null && child.startIndex > cursor) {
      const gap = child.startIndex - cursor
      value += '\n'.repeat(gap)
      sawLiteral = true
    }

    switch (child.type) {
      case 'string_content':
        value += removeDoubleQuoteEscapes(child.text)
        sawLiteral = true
        break
      case '$':
        value += '$'
        sawLiteral = true
        break
      case 'command_substitution': {
        const heredoc = tryResolveHeredocPrintingSubstitution(child)
        if (heredoc !== null) {
          value += heredoc.text
          sawLiteral = true
        } else {
          extractSubstitutionCommands(child, scope, ctx)
          value += SUBSTITUTION_MARKER
          sawUnknown = true
        }
        break
      }
      case 'simple_expansion': {
        const resolved = resolveVariableReference(child, scope, true)
        value += resolved.value
        if (resolved.unknown) sawUnknown = true
        else sawLiteral = true
        break
      }
      case 'arithmetic_expansion':
        validateArithmetic(child)
        value += child.text
        sawLiteral = true
        break
      default:
        throw refusalForNode(child)
    }
    cursor = child.endIndex
  }

  if (sawUnknown && !sawLiteral) {
    throw new TooComplexError(
      'quoted argument consists entirely of runtime-determined content',
      node.type,
    )
  }
  if (!sawLiteral && !sawUnknown && node.text.length > 2) {
    throw new TooComplexError(
      'whitespace-only quoted string cannot be analyzed faithfully',
      node.type,
    )
  }
  return { value, sawLiteral, sawUnknown }
}


function resolveArgument(node: Node | null | undefined, scope: VariableScope, ctx: WalkContext): string {
  if (!node) {
    throw new TooComplexError('missing argument node')
  }
  switch (node.type) {
    case 'word':
      refuseOnBraceExpansion(node)
      return removeBackslashEscapes(node.text)
    case 'number':
      if (node.children.length > 0) {
        const child = node.children[0] as Node
        throw new TooComplexError(
          `number carries an embedded expansion (${child.type})`,
          child.type,
        )
      }
      return node.text
    case 'raw_string':
      return node.text.slice(1, -1)
    case 'string':
      return resolveDoubleQuotedString(node, scope, ctx).value
    case 'concatenation': {
      refuseOnBraceExpansion(node)
      let value = ''
      for (const child of node.children) {
        value += resolveArgument(child, scope, ctx)
      }
      return value
    }
    case 'arithmetic_expansion':
      validateArithmetic(node)
      return node.text
    case 'simple_expansion':
      return resolveVariableReference(node, scope, false).value
    default:
      throw refusalForNode(node)
  }
}


const REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
  '>',
  '>>',
  '<',
  '>&',
  '<&',
  '>|',
  '&>',
  '&>>',
  '<<<',
])

function resolveFileRedirect(node: Node, scope: VariableScope, ctx: WalkContext): Redirect {
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
    switch (child.type) {
      case 'word':
      case 'number':
        if (child.children.length > 0) {
          throw refusalForNode(child.children[0] as Node)
        }
        refuseOnBraceExpansion(child)
        target = removeBackslashEscapes(child.text)
        break
      case 'raw_string':
        target = child.text.slice(1, -1)
        break
      case 'string':
        target = resolveDoubleQuotedString(child, scope, ctx).value
        break
      case 'concatenation':
        target = resolveArgument(child, scope, ctx)
        break
      default:
        throw refusalForNode(child)
    }
  }

  if (op === undefined || target === undefined) {
    throw new TooComplexError('unrecognised redirect shape', node.type)
  }
  return fd === undefined ? { op, target } : { op, target, fd }
}


type ValidatedAssignment = { name: string; value: string; append: boolean }

const PS4_SAFE_VALUE_RE = /^[A-Za-z0-9 _+:./=[\]-]*$/
const PS4_REFERENCE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g

function validateAssignment(
  node: Node,
  scope: VariableScope,
  ctx: WalkContext,
): ValidatedAssignment {
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
      case 'command_substitution': {
        extractSubstitutionCommands(child, scope, ctx)
        value = SUBSTITUTION_MARKER
        break
      }
      case 'simple_expansion': {
        value = resolveVariableReference(child, scope, true).value
        break
      }
      default:
        value = resolveArgument(child, scope, ctx)
        break
    }
  }

  if (name === undefined) {
    throw new TooComplexError('variable assignment has no name', node.type)
  }
  if (!SHELL_IDENTIFIER_RE.test(name)) {
    throw new TooComplexError(
      `assignment name ${JSON.stringify(name)} is not a valid shell identifier`,
      node.type,
    )
  }
  if (name === 'IFS') {
    throw new TooComplexError('assignment to IFS cannot be analyzed safely', node.type)
  }
  if (name === 'PS4') {
    if (append) {
      throw new TooComplexError('appending to PS4 cannot be analyzed safely', node.type)
    }
    if (!isLiteralValue(value)) {
      throw new TooComplexError(
        'PS4 value derived at runtime cannot be analyzed safely',
        node.type,
      )
    }
    const remainder = value.replace(PS4_REFERENCE_RE, '')
    if (!PS4_SAFE_VALUE_RE.test(remainder)) {
      throw new TooComplexError(
        'PS4 value contains characters outside the safe trace-prefix set',
        node.type,
      )
    }
  }
  if (value.includes('~')) {
    throw new TooComplexError(
      'assignment value contains ~, which the shell may expand at assignment time',
      node.type,
    )
  }
  return { name, value, append }
}

function recordAssignment(scope: VariableScope, assignment: ValidatedAssignment): void {
  if (assignment.append) {
    scope.set(assignment.name, combineAppend(scope.get(assignment.name) ?? '', assignment.value))
  } else {
    scope.set(assignment.name, assignment.value)
  }
}


const DOLLAR_REFERENCE_RE = /\$[A-Za-z_]/

const NEEDS_QUOTING_RE = /["'\\ \t\n$`;|&<>(){}*?[\]~#]/

function escapeArgvElement(element: string): string {
  if (element !== '' && !NEEDS_QUOTING_RE.test(element)) return element
  return `'${element.replace(/'/g, "'\\''")}'`
}

function commandTextForSpan(rawSpan: string, argv: string[]): string {
  if (DOLLAR_REFERENCE_RE.test(rawSpan) || rawSpan.includes('\n')) {
    return argv.map(escapeArgvElement).join(' ')
  }
  return rawSpan
}


function handleSimpleCommand(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  const redirects: Redirect[] = []

  for (const child of node.children) {
    switch (child.type) {
      case 'variable_assignment': {
        const assignment = validateAssignment(child, scope, ctx)
        envVars.push({ name: assignment.name, value: assignment.value })
        break
      }
      case 'command_name': {
        const inner = child.children.length > 0 ? (child.children[0] as Node) : child
        argv.push(resolveArgument(inner, scope, ctx))
        break
      }
      case 'word':
      case 'number':
      case 'raw_string':
      case 'string':
      case 'concatenation':
      case 'arithmetic_expansion':
      case 'simple_expansion':
        argv.push(resolveArgument(child, scope, ctx))
        break
      case 'file_redirect':
        redirects.push(resolveFileRedirect(child, scope, ctx))
        break
      case 'herestring_redirect': {
        for (const hsChild of child.children) {
          if (hsChild.type === 'file_descriptor') throw refusalForNode(hsChild)
          if (hsChild.type === '<<<') continue
          const content = resolveArgument(hsChild, scope, ctx)
          if (NEWLINE_THEN_COMMENT_RE.test(content)) {
            throw new TooComplexError(
              'here-string content contains a newline followed by a comment',
              child.type,
            )
          }
        }
        break
      }
      default:
        throw refusalForNode(child)
    }
  }

  ctx.commands.push({
    argv,
    envVars,
    redirects,
    text: commandTextForSpan(node.text, argv),
  })
}


const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  'export',
  'local',
  'readonly',
  'declare',
  'typeset',
])

const SUBSCRIPT_SENSITIVE_DECLARATIONS: ReadonlySet<string> = new Set([
  'declare',
  'typeset',
  'local',
])

function handleDeclarationCommand(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const argv: string[] = []

  for (const child of node.children) {
    if (argv.length === 0 && DECLARATION_KEYWORDS.has(child.type)) {
      argv.push(child.text)
      continue
    }
    switch (child.type) {
      case 'word':
      case 'number':
      case 'raw_string':
      case 'string':
      case 'concatenation': {
        const resolved = resolveArgument(child, scope, ctx)
        if (SUBSCRIPT_SENSITIVE_DECLARATIONS.has(argv[0] ?? '')) {
          if (resolved.startsWith('-')) {
            const letterRun = /^-([A-Za-z]*)/.exec(resolved)?.[1] ?? ''
            if (/[niaA]/.test(letterRun)) {
              throw new TooComplexError(
                `declaration flag ${JSON.stringify(resolved)} creates a nameref, integer or array variable`,
                node.type,
              )
            }
          } else {
            const bracketIndex = resolved.indexOf('[')
            const equalsIndex = resolved.indexOf('=')
            if (bracketIndex !== -1 && (equalsIndex === -1 || bracketIndex < equalsIndex)) {
              throw new TooComplexError(
                `declaration operand ${JSON.stringify(resolved)} carries an array subscript`,
                node.type,
              )
            }
          }
        }
        argv.push(resolved)
        break
      }
      case 'variable_assignment': {
        const assignment = validateAssignment(child, scope, ctx)
        recordAssignment(scope, assignment)
        argv.push(`${assignment.name}=${assignment.value}`)
        break
      }
      case 'variable_name':
        argv.push(child.text)
        break
      default:
        throw refusalForNode(child)
    }
  }

  ctx.commands.push({ argv, envVars: [], redirects: [], text: node.text })
}


function handleUnsetCommand(node: Node, scope: VariableScope, ctx: WalkContext): void {
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
        argv.push(resolveArgument(child, scope, ctx))
        break
      default:
        throw refusalForNode(child)
    }
  }
  ctx.commands.push({ argv, envVars: [], redirects: [], text: node.text })
}


const TEST_TOKEN_TYPES: ReadonlySet<string> = new Set([
  '!',
  '(',
  ')',
  '&&',
  '||',
  '==',
  '=',
  '!=',
  '<',
  '>',
  '=~',
])

function handleTestCommand(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const argv: string[] = ['[[']

  const walkExpression = (expr: Node): void => {
    switch (expr.type) {
      case 'binary_expression':
      case 'unary_expression':
      case 'parenthesized_expression':
      case 'negated_command':
        for (const child of expr.children) walkExpression(child)
        return
      case 'test_operator':
        argv.push(expr.text)
        return
      case 'regex':
      case 'extglob_pattern':
        argv.push(expr.text)
        return
      default:
        if (TEST_TOKEN_TYPES.has(expr.type)) {
          argv.push(expr.text)
          return
        }
        argv.push(resolveArgument(expr, scope, ctx))
    }
  }

  for (const child of node.children) {
    if (child.type === '[[' || child.type === ']]' || child.type === '[' || child.type === ']') {
      continue
    }
    walkExpression(child)
  }

  ctx.commands.push({ argv, envVars: [], redirects: [], text: node.text })
}


const REDIRECTABLE_INNER_TYPES: ReadonlySet<string> = new Set([
  'command',
  'pipeline',
  'list',
  'negated_command',
  'declaration_command',
  'unset_command',
])

function handleRedirectedStatement(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const redirects: Redirect[] = []
  let inner: Node | null = null

  for (const child of node.children) {
    if (child.type === 'file_redirect') {
      redirects.push(resolveFileRedirect(child, scope, ctx))
      continue
    }
    if (child.type === 'heredoc_redirect') {
      validateHeredocRedirect(child)
      continue
    }
    if (REDIRECTABLE_INNER_TYPES.has(child.type)) {
      inner = child
      continue
    }
    throw refusalForNode(child)
  }

  if (!inner) {
    ctx.commands.push({ argv: [], envVars: [], redirects, text: node.text })
    return
  }

  const before = ctx.commands.length
  walkNode(inner, scope, ctx)
  if (ctx.commands.length > before && redirects.length > 0) {
    const last = ctx.commands[ctx.commands.length - 1] as SimpleCommand
    last.redirects.push(...redirects)
  }
}


function handleForStatement(node: Node, scope: VariableScope, ctx: WalkContext): void {
  let loopVariable: string | null = null
  let body: Node | null = null

  for (const child of node.children) {
    switch (child.type) {
      case 'for':
      case 'select':
      case 'in':
      case ';':
        break
      case 'variable_name':
        loopVariable = child.text
        break
      case 'do_group':
        body = child
        break
      case 'command_substitution':
        extractSubstitutionCommands(child, scope, ctx)
        break
      default:
        resolveArgument(child, scope, ctx)
        break
    }
  }

  if (loopVariable === null || body === null) {
    throw new TooComplexError('loop is missing its variable or body', node.type)
  }
  if (loopVariable === 'IFS' || loopVariable === 'PS4') {
    throw new TooComplexError(
      `loop variable ${loopVariable} cannot be analyzed safely`,
      node.type,
    )
  }

  scope.set(loopVariable, UNKNOWN_MARKER)

  const bodyScope = new Map(scope)
  for (const statement of body.children) {
    if (statement.type === 'do' || statement.type === 'done' || statement.type === ';') continue
    walkNode(statement, bodyScope, ctx)
  }
}


function trackConditionReads(commands: SimpleCommand[], scope: VariableScope, nodeType: string): void {
  for (const command of commands) {
    if (command.argv[0] !== 'read') continue
    for (const operand of command.argv.slice(1)) {
      if (operand.startsWith('-')) continue
      if (!SHELL_IDENTIFIER_RE.test(operand)) continue
      const existing = scope.get(operand)
      if (existing !== undefined && isLiteralValue(existing)) {
        throw new TooComplexError(
          `conditional read into ${operand} may mask its statically tracked value`,
          nodeType,
        )
      }
      scope.set(operand, UNKNOWN_MARKER)
    }
  }
}

function handleIfStatement(node: Node, scope: VariableScope, ctx: WalkContext): void {
  let seenThen = false

  for (const child of node.children) {
    switch (child.type) {
      case 'if':
      case 'fi':
      case ';':
        break
      case 'then':
        seenThen = true
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
              walkNode(statement, clauseScope, ctx)
          }
        }
        break
      }
      default:
        if (!seenThen) {
          const before = ctx.commands.length
          walkNode(child, scope, ctx)
          trackConditionReads(ctx.commands.slice(before), scope, node.type)
        } else {
          walkNode(child, new Map(scope), ctx)
        }
    }
  }
}

function handleWhileStatement(node: Node, scope: VariableScope, ctx: WalkContext): void {
  for (const child of node.children) {
    switch (child.type) {
      case 'while':
      case 'until':
      case ';':
        break
      case 'do_group': {
        const bodyScope = new Map(scope)
        for (const statement of child.children) {
          if (statement.type === 'do' || statement.type === 'done' || statement.type === ';') {
            continue
          }
          walkNode(statement, bodyScope, ctx)
        }
        break
      }
      default: {
        const before = ctx.commands.length
        walkNode(child, scope, ctx)
        trackConditionReads(ctx.commands.slice(before), scope, node.type)
      }
    }
  }
}


function walkStatementList(children: Node[], scope: VariableScope, ctx: WalkContext): void {
  const needsSnapshot = children.some(child => child.type === '||' || child.type === '&')
  const snapshot = needsSnapshot ? new Map(scope) : null
  let current = scope
  for (const child of children) {
    switch (child.type) {
      case '&&':
      case ';':
      case '\n':
        break
      case '||':
      case '&':
        current = new Map(snapshot as VariableScope)
        break
      default:
        walkNode(child, current, ctx)
    }
  }
}

function handlePipeline(node: Node, scope: VariableScope, ctx: WalkContext): void {
  let current = new Map(scope)
  for (const child of node.children) {
    if (child.type === '|' || child.type === '|&') {
      current = new Map(scope)
      continue
    }
    if (child.type === '\n') continue
    walkNode(child, current, ctx)
  }
}


function walkNode(node: Node, scope: VariableScope, ctx: WalkContext): void {
  switch (node.type) {
    case 'program':
    case 'list':
      walkStatementList(node.children, scope, ctx)
      return
    case 'pipeline':
      handlePipeline(node, scope, ctx)
      return
    case 'comment':
      return
    case 'command':
      handleSimpleCommand(node, scope, ctx)
      return
    case 'redirected_statement':
      handleRedirectedStatement(node, scope, ctx)
      return
    case 'negated_command': {
      for (const child of node.children) {
        if (child.type === '!') continue
        walkNode(child, scope, ctx)
        return
      }
      return
    }
    case 'declaration_command':
      handleDeclarationCommand(node, scope, ctx)
      return
    case 'variable_assignment': {
      const assignment = validateAssignment(node, scope, ctx)
      recordAssignment(scope, assignment)
      return
    }
    case 'for_statement':
      handleForStatement(node, scope, ctx)
      return
    case 'if_statement':
      handleIfStatement(node, scope, ctx)
      return
    case 'while_statement':
      handleWhileStatement(node, scope, ctx)
      return
    case 'subshell': {
      const subshellScope = new Map(scope)
      const statements: Node[] = []
      for (const child of node.children) {
        if (child.type === '(' || child.type === ')') continue
        if (child.type === ';' || child.type === '&') throw refusalForNode(child)
        statements.push(child)
      }
      walkStatementList(statements, subshellScope, ctx)
      return
    }
    case 'test_command':
      handleTestCommand(node, scope, ctx)
      return
    case 'unset_command':
      handleUnsetCommand(node, scope, ctx)
      return
    default:
      throw refusalForNode(node)
  }
}


const PARSE_ABORT_NODE_TYPE = 'PARSE_ABORT'
const PARSE_ABORT_REASON =
  'Parser aborted (timeout or resource limit) — possible adversarial input'

export function parseForSecurityFromAst(
  command: string,
  root: Node | typeof PARSE_ABORTED,
): ParseForSecurityResult {
  const preCheckReason = runPreChecks(command)
  if (preCheckReason !== null) {
    return { kind: 'too-complex', reason: preCheckReason }
  }
  if (command.trim() === '') {
    return { kind: 'simple', commands: [] }
  }
  if (root === PARSE_ABORTED) {
    return { kind: 'too-complex', reason: PARSE_ABORT_REASON, nodeType: PARSE_ABORT_NODE_TYPE }
  }
  try {
    const ctx: WalkContext = { commands: [] }
    walkNode(root, new Map(), ctx)
    return { kind: 'simple', commands: ctx.commands }
  } catch (error) {
    if (error instanceof TooComplexError) {
      if (error.nodeType === undefined) {
        return { kind: 'too-complex', reason: error.reason }
      }
      return { kind: 'too-complex', reason: error.reason, nodeType: error.nodeType }
    }
    return {
      kind: 'too-complex',
      reason: `analysis failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function parseForSecurity(command: string): Promise<ParseForSecurityResult> {
  if (command === '') {
    return { kind: 'simple', commands: [] }
  }
  const root = await parseCommandRaw(command)
  if (root === null) {
    return { kind: 'parse-unavailable' }
  }
  return parseForSecurityFromAst(command, root)
}


const SUBSCRIPT_FLAGS_BY_BUILTIN: ReadonlyMap<string, readonly string[]> = new Map([
  ['test', ['-v', '-R']],
  ['[', ['-v', '-R']],
  ['[[', ['-v', '-R']],
  ['printf', ['-v']],
  ['read', ['-a']],
  ['unset', ['-v']],
  ['wait', ['-p']],
])

const ARITHMETIC_COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
])

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

const ARGUMENT_EVALUATING_BUILTINS: ReadonlySet<string> = new Set([
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

type StripOutcome = { argv: string[] } | { failReason: string }

function stripTransparentWrappers(originalArgv: string[]): StripOutcome {
  let argv = originalArgv
  for (;;) {
    const name = argv[0]
    if (name === 'time' || name === 'nohup') {
      argv = argv.slice(1)
      continue
    }
    if (name === 'timeout') {
      let i = 1
      let failed: string | null = null
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
            failed = flag
            break
          }
          i += 2
        } else if (flag === '-v') {
          i += 1
        } else if (
          (flag.startsWith('-k') || flag.startsWith('-s')) &&
          flag.length > 2 &&
          TIMEOUT_VALUE_RE.test(flag.slice(2))
        ) {
          i += 1
        } else {
          failed = flag
          break
        }
      }
      if (failed !== null) {
        return { failReason: `unrecognised timeout flag ${JSON.stringify(failed)} hides the wrapped command` }
      }
      if (i >= argv.length) break
      const duration = argv[i] as string
      if (!TIMEOUT_DURATION_RE.test(duration)) {
        return { failReason: `unrecognised timeout duration ${JSON.stringify(duration)}` }
      }
      argv = argv.slice(i + 1)
      continue
    }
    if (name === 'nice') {
      const first = argv[1]
      if (first === '-n' && argv[2] !== undefined && /^-?[0-9]+$/.test(argv[2])) {
        argv = argv.slice(3)
        continue
      }
      if (first !== undefined && /^-[0-9]+$/.test(first)) {
        argv = argv.slice(2)
        continue
      }
      if (first !== undefined && /[$(`]/.test(first)) {
        return { failReason: `unsafe nice argument ${JSON.stringify(first)}` }
      }
      argv = argv.slice(1)
      continue
    }
    if (name === 'env') {
      let i = 1
      let failed: string | null = null
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
            failed = arg
            break
          }
          i += 2
          continue
        }
        if (arg.startsWith('-')) {
          failed = arg
          break
        }
        break
      }
      if (failed !== null) {
        return { failReason: `unrecognised env flag ${JSON.stringify(failed)} hides the wrapped command` }
      }
      if (i >= argv.length) break
      argv = argv.slice(i)
      continue
    }
    if (name === 'stdbuf') {
      let i = 1
      let consumed = false
      let failed: string | null = null
      while (i < argv.length) {
        const arg = argv[i] as string
        if ((arg === '-i' || arg === '-o' || arg === '-e') && argv[i + 1] !== undefined) {
          i += 2
          consumed = true
          continue
        }
        if (/^-[ioe]./.test(arg)) {
          i += 1
          consumed = true
          continue
        }
        if (/^--(?:input|output|error)=/.test(arg)) {
          i += 1
          consumed = true
          continue
        }
        if (arg.startsWith('-')) {
          failed = arg
          break
        }
        break
      }
      if (failed !== null) {
        return { failReason: `unrecognised stdbuf flag ${JSON.stringify(failed)} hides the wrapped command` }
      }
      if (!consumed || i >= argv.length) break
      argv = argv.slice(i)
      continue
    }
    break
  }
  return { argv }
}

function readClusterConsumesNextArgument(cluster: string): boolean {
  for (let i = 1; i < cluster.length; i++) {
    if (READ_DATA_FLAGS.has(cluster[i] as string)) {
      return i === cluster.length - 1
    }
  }
  return false
}

function checkOneCommand(command: SimpleCommand): string | null {
  const stripOutcome = stripTransparentWrappers(command.argv)
  if ('failReason' in stripOutcome) return stripOutcome.failReason
  const stripped = stripOutcome.argv
  const name = stripped[0]

  if (name === undefined) return null

  if (name === '') {
    return 'command name is empty, so argv[0] may not reflect what the shell runs'
  }

  if (!isLiteralValue(name)) {
    return 'command name is determined at runtime'
  }

  if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
    return `argv starts with the incomplete fragment ${JSON.stringify(name)}`
  }

  const subscriptFlags = SUBSCRIPT_FLAGS_BY_BUILTIN.get(name)
  if (subscriptFlags !== undefined) {
    for (let i = 1; i < stripped.length; i++) {
      const arg = stripped[i] as string
      const next = stripped[i + 1]
      for (const flag of subscriptFlags) {
        const letter = flag[1] as string
        if (arg === flag && next !== undefined && next.includes('[')) {
          return `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
        }
        if (
          arg.length > 2 &&
          arg.startsWith('-') &&
          arg[1] !== '-' &&
          !arg.includes('[') &&
          arg.slice(1).includes(letter) &&
          next !== undefined &&
          next.includes('[')
        ) {
          return `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
        }
        if (arg.startsWith(flag) && arg.length > 2 && arg.includes('[')) {
          return `${name} ${flag} with a bracketed name evaluates array subscripts, which can execute code`
        }
      }
    }
  }

  if (name === '[[') {
    for (let i = 2; i < stripped.length; i++) {
      if (!ARITHMETIC_COMPARISON_OPERATORS.has(stripped[i] as string)) continue
      const left = stripped[i - 1] as string
      const right = stripped[i + 1]
      if (left.includes('[') || (right !== undefined && right.includes('['))) {
        return 'arithmetic comparison inside [[ ]] evaluates bracketed subscripts, which can execute code'
      }
    }
  }

  if (name === 'read' || name === 'unset') {
    let i = 1
    while (i < stripped.length) {
      const arg = stripped[i] as string
      if (arg.startsWith('-')) {
        if (name === 'read' && readClusterConsumesNextArgument(arg)) i += 1
        i += 1
        continue
      }
      if (arg.includes('[')) {
        return `${name} with a bracketed name operand evaluates array subscripts, which can execute code`
      }
      i += 1
    }
  }

  if (SHELL_KEYWORDS.has(name)) {
    return `reserved word ${JSON.stringify(name)} as a command name indicates a mis-parsed command`
  }

  for (const arg of command.argv) {
    if (NEWLINE_THEN_COMMENT_RE.test(arg)) {
      return 'a command argument contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  for (const envVar of command.envVars) {
    if (NEWLINE_THEN_COMMENT_RE.test(envVar.value)) {
      return 'an environment variable value contains a newline followed by a comment, which can hide arguments from validation'
    }
  }
  for (const redirect of command.redirects) {
    if (NEWLINE_THEN_COMMENT_RE.test(redirect.target)) {
      return 'a redirect target contains a newline followed by a comment, which can hide arguments from validation'
    }
  }

  if (name === 'jq') {
    for (const arg of stripped) {
      if (SYSTEM_CALL_RE.test(arg)) {
        return 'jq program contains a system() call, which executes arbitrary commands'
      }
      if (JQ_SHORT_FILE_FLAG_RE.test(arg) || JQ_LONG_FILE_FLAG_RE.test(arg)) {
        return `jq flag ${JSON.stringify(arg)} enables code execution or arbitrary file reads`
      }
    }
  }

  if (ZSH_MODULE_BUILTINS.has(name)) {
    return `${name} is a zsh module builtin that can bypass security checks`
  }

  if (ARGUMENT_EVALUATING_BUILTINS.has(name)) {
    if (name === 'command') {
      if (stripped[1] !== '-v' && stripped[1] !== '-V') {
        return 'command bypasses function and alias lookup, so the effective target cannot be validated'
      }
    } else if (name === 'fc') {
      for (const arg of stripped.slice(1)) {
        if (arg.startsWith('-') && !arg.startsWith('--') && /[es]/.test(arg)) {
          return 'fc in editor or re-execute mode runs the resulting command'
        }
      }
    } else if (name === 'compgen') {
      for (const arg of stripped.slice(1)) {
        if (arg.startsWith('-') && !arg.startsWith('--') && /[CFW]/.test(arg)) {
          return 'compgen with -C, -F or -W executes code while generating completions'
        }
      }
    } else {
      return `${name} evaluates its arguments as shell code`
    }
  }

  for (const arg of command.argv) {
    if (PROC_ENVIRON_RE.test(arg)) {
      return 'references a process environment file, which may expose secrets'
    }
  }
  for (const redirect of command.redirects) {
    if (PROC_ENVIRON_RE.test(redirect.target)) {
      return 'redirects from a process environment file, which may expose secrets'
    }
  }

  return null
}

export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const command of commands) {
    const failure = checkOneCommand(command)
    if (failure !== null) {
      return { ok: false, reason: failure }
    }
  }
  return { ok: true }
}


export function nodeTypeId(nodeType?: string): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const index = DANGEROUS_NODE_TYPES.indexOf(nodeType)
  return index === -1 ? 0 : index + 1
}
