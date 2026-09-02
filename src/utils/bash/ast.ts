/**
 * Fail-closed static security analysis of a bash command string.
 *
 * The analyser converts a command into a flat list of simple commands — each
 * with a trustworthy argv, leading environment assignments, redirects and a
 * source-text span — or refuses the whole string as too complex. Nothing here
 * blocks execution; the only question answered is whether the permission
 * chain may reason about the command on its own or must put it in front of
 * the operator. Every ambiguity therefore resolves toward refusal: the walk
 * is an allowlist over node shapes, and anything outside it refuses.
 *
 * The tree consumed here is the tree-sitter-bash-shaped AST produced by the
 * parse facade (`./parser.js`). Node span offsets are UTF-8 byte offsets;
 * this module works from node text and offset arithmetic only, so it never
 * slices the JS string with byte offsets.
 */
import { SHELL_KEYWORDS } from './bashParser.js'
import { PARSE_ABORTED, parseCommandRaw, type Node } from './parser.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public result types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One file redirect attached to a simple command. The `op` union is wider
 * than what the redirect extractor produces: `<<` is carried for callers even
 * though heredocs are handled separately and never map here.
 */
export type Redirect = {
  op: '>' | '>>' | '<' | '<<' | '>&' | '>|' | '<&' | '&>' | '&>>' | '<<<'
  target: string
  fd?: number
}

/** One extracted simple command with quotes already resolved in argv. */
export type SimpleCommand = {
  argv: string[]
  envVars: { name: string; value: string }[]
  redirects: Redirect[]
  text: string
}

/** The extraction verdict. `parse-unavailable` is produced only by the string entry point. */
export type ParseForSecurityResult =
  | { kind: 'simple'; commands: SimpleCommand[] }
  | { kind: 'too-complex'; reason: string; nodeType?: string }
  | { kind: 'parse-unavailable' }

/** The semantic-check verdict over an extracted command list. */
export type SemanticCheckResult = { ok: true } | { ok: false; reason: string }

// ─────────────────────────────────────────────────────────────────────────────
// Internal refusal plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** Internal control-flow carrier for a too-complex refusal; never escapes the module. */
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

/**
 * The node types that always refuse. The real safety guarantee is the
 * allowlist walk, not this list — its job is reason derivation and, above
 * all, a STABLE id vocabulary: analytics ids are the 1-based position in
 * this list, so entries are never removed or reordered, only appended.
 * (The until-loop entry is never produced by the current parser — `until`
 * rides the while node — and the translated-string entry likewise; both stay
 * because their positions are ids.)
 */
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

/** Derive the standard refusal for a node the walk does not accept in this position. */
function refusalForNode(node: Node): TooComplexError {
  if (node.type === 'ERROR') return new TooComplexError('parse error', node.type)
  if (DANGEROUS_NODE_TYPES.includes(node.type)) {
    return new TooComplexError(`contains ${node.type}`, node.type)
  }
  return new TooComplexError(`unhandled node type ${node.type}`, node.type)
}

// ─────────────────────────────────────────────────────────────────────────────
// Value model: tracked variables hold a pure literal or a runtime-unknown marker
// ─────────────────────────────────────────────────────────────────────────────

/** Marker for values produced by command substitution. */
const SUBSTITUTION_MARKER = '__MERCURY_UNKNOWN_SUBSTITUTION__'
/** Marker for values unknown for any other reason. */
const UNKNOWN_MARKER = '__MERCURY_UNKNOWN_VALUE__'

/**
 * A value is literal only when it contains NEITHER marker. Containment (not
 * equality) makes composite values — literal text concatenated with
 * substitution output — unknown too. Side effect kept on purpose: a
 * user-typed literal that happens to contain a marker string is treated as
 * unknown, which is conservative and harmless.
 */
function isLiteralValue(value: string): boolean {
  return !value.includes(SUBSTITUTION_MARKER) && !value.includes(UNKNOWN_MARKER)
}

/** Variables assigned earlier in the same command string. */
type VariableScope = Map<string, string>

/** Append-assignment combination: any unknown side poisons the whole value. */
function combineAppend(existing: string, added: string): string {
  if (!isLiteralValue(existing) || !isLiteralValue(added)) return UNKNOWN_MARKER
  return existing + added
}

/** Shell-maintained variables that resolve (to a marker) inside strings without being tracked. */
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

/**
 * Special variables allowed inside strings. `@` and `*` are deliberately
 * excluded: in the fresh shell the harness spawns the positional parameters
 * are empty, so a marker for them would put content in argv that the shell
 * passes nothing for — and deny rules would then match neither form.
 */
const ALLOWED_SPECIAL_VARIABLES: ReadonlySet<string> = new Set(['?', '$', '!', '#', '0', '-'])

// ─────────────────────────────────────────────────────────────────────────────
// Pre-checks over the raw command string
// ─────────────────────────────────────────────────────────────────────────────

/** C0 controls (minus tab/newline) plus DEL: the shell silently drops these while the parser does not. */
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/
/** Unicode whitespace invisible in a terminal that the shell treats as ordinary word characters. */
const UNICODE_WHITESPACE_RE =
  /[\u00A0\u1680\u2000-\u200B\u2028\u2029\u202F\u205F\u3000\uFEFF]/
/** Backslash directly before a space or tab: one word to the shell, two to the parser. */
const ESCAPED_BLANK_RE = /\\[ \t]/
/** A mid-word line continuation: backslash-newline preceded by a non-whitespace, non-backslash character. */
const MIDWORD_CONTINUATION_RE = /[^ \t\n\\]\\\n/
/** Word-initial `=` followed by an identifier start: zsh expands `=cmd` to an absolute path. */
const ZSH_EQUALS_EXPANSION_RE = /(^|[ \t\n;&|])=[A-Za-z_]/
/** An unquoted `{` whose brace run contains a quote character (checked on the masked command). */
const BRACE_WITH_QUOTE_RE = /\{[^}]*['"]/

/**
 * Replace `{` characters that sit inside single- or double-quoted spans with
 * a space, using a real shell quote-state scan. Quote characters themselves
 * stay visible so obfuscation patterns still match through an outer unquoted
 * brace, and a backslash-escaped brace outside quotes stays visible too.
 */
function maskQuotedBraces(command: string): string {
  let out = ''
  let state: 'plain' | 'single' | 'double' = 'plain'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    if (state === 'plain') {
      if (ch === '\\' && i + 1 < command.length) {
        // Outside quotes a backslash escapes the next character; both stay visible.
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
      // No escapes inside single quotes; the closing quote always terminates.
      if (ch === "'") {
        state = 'plain'
        out += ch
      } else {
        out += ch === '{' ? ' ' : ch
      }
      continue
    }
    // Double quotes: a backslash escapes only `"` and `\` for quote-state purposes.
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

/**
 * The known tokenization disagreements between the parser and the shell,
 * checked on the raw string before any tree is trusted. Order matters; none
 * of these refusals carries a node type.
 */
function runPreChecks(command: string): string | null {
  if (CONTROL_CHARACTER_RE.test(command)) {
    // Contract data: this reason string is pinned byte-exact by the command-analysis corpus.
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

// ─────────────────────────────────────────────────────────────────────────────
// Small node helpers
// ─────────────────────────────────────────────────────────────────────────────

function firstChildOfType(node: Node, type: string): Node | undefined {
  return node.children.find(child => child.type === type)
}

/** Brace-expansion syntax: a brace pair with no nested braces or whitespace holding a comma or a `..` range. */
const BRACE_EXPANSION_RE = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/

function refuseOnBraceExpansion(node: Node): void {
  if (BRACE_EXPANSION_RE.test(node.text)) {
    // Escaped opening braces are deliberately not distinguished: the parser
    // does not unescape backslashes, so both spellings refuse and a literal
    // brace can always be single-quoted instead.
    throw new TooComplexError('contains brace expansion syntax', node.type)
  }
}

/** Unquoted-word quote removal: `\X` becomes `X` for any X. */
function removeBackslashEscapes(text: string): string {
  return text.replace(/\\(.)/g, '$1')
}

/** Double-quote quote removal: a backslash escapes only `$`, backtick, `"` and backslash. */
function removeDoubleQuoteEscapes(text: string): string {
  return text.replace(/\\([$`"\\])/g, '$1')
}

/** A valid shell identifier: letter or underscore, then letters, digits or underscores. */
const SHELL_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A newline followed by optional blanks and a comment marker (see the semantic checks). */
const NEWLINE_THEN_COMMENT_RE = /\n[ \t]*#/

/** A path reaching a process environment file. The middle segment matches any
 * characters (not just non-separators) because the platform resolves
 * parent-directory segments inside that filesystem. */
const PROC_ENVIRON_RE = /\/proc\/.*\/environ/

/** The word `system` at a word boundary followed by an opening parenthesis. */
const SYSTEM_CALL_RE = /\bsystem\s*\(/

// ─────────────────────────────────────────────────────────────────────────────
// The walk context
// ─────────────────────────────────────────────────────────────────────────────

type WalkContext = {
  commands: SimpleCommand[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable references
// ─────────────────────────────────────────────────────────────────────────────

type ReferenceResolution = { value: string; unknown: boolean }

/**
 * Resolve a `$VAR` reference (a simple_expansion node) under the rules.
 * Inside a string an unknown resolves to a marker; as a bare argument every
 * uncertain shape refuses, because the runtime value IS the argument.
 */
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
    // Tracked literal text is substituted as-is: whatever checks the resulting
    // argv later must be able to read the concrete string, never a marker.
    if (!insideString) {
      if (tracked === '') {
        // The shell drops an empty unquoted field entirely, shifting argv.
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

  // Untracked names resolve only inside a string, and only for the closed
  // sets the shell itself maintains.
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

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetic validation
// ─────────────────────────────────────────────────────────────────────────────

/** Literal-arithmetic leaf shapes: integers in the three shell notations. */
const ARITH_INTEGER_RE = /^(?:[0-9]+|0[xX][0-9A-Fa-f]+|[0-9]+#[0-9A-Za-z]+)$/
/** A run of arithmetic operator / parenthesis / comparison characters. */
const ARITH_OPERATOR_RUN_RE = /^[-+*/%^&|~!<>=?:(),]+$/

/**
 * Shell arithmetic recursively evaluates variable values, so an arithmetic
 * context can execute a command substitution smuggled inside a variable.
 * Only numeric literals and operator tokens are allowed; a variable
 * reference at leaf position refuses because it is not a numeric literal.
 */
function validateArithmetic(node: Node): void {
  for (const child of node.children) {
    if (child.children.length === 0) {
      const text = child.text
      if (
        text === '$((' || // the expansion's own opening delimiter: `$` is not in the operator set
        ARITH_INTEGER_RE.test(text) ||
        ARITH_OPERATOR_RUN_RE.test(text)
      ) {
        continue
      }
      // Report the arithmetic-expansion node type, not the inner leaf, so the
      // analytics id maps to the arithmetic-expansion entry.
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

// ─────────────────────────────────────────────────────────────────────────────
// Command substitutions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the inner statements of a command substitution into the shared
 * command list. Variables set before are visible inside (a copy of the
 * scope); variables set inside never leak out.
 */
function extractSubstitutionCommands(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const innerScope = new Map(scope)
  const statements = node.children.filter(
    child => child.type !== '$(' && child.type !== ')' && child.type !== '`',
  )
  walkStatementList(statements, innerScope, ctx)
}

/**
 * The everyday "feed multi-line text to a tool" shape: a substitution that is
 * exactly `cat` fed by a quoted-delimiter heredoc has a statically known
 * result — the heredoc body. Returns null when the shape does not match
 * (falls through to general substitution handling), otherwise the body
 * handling result. Throws the hard refusals for dangerous body content.
 */
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

  // Trailing newlines are trimmed, matching what the shell strips from
  // substitution results.
  const trimmed = body.replace(/\n+$/, '')

  // The semantic checks never see heredoc bodies, so dangerous content is
  // refused here — a distinct refusal that never falls through to the
  // general substitution path (which would extract only the inner `cat`).
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
    // Multi-line text cannot be a valid path; keeping it would false-positive
    // the newline-then-comment check. It still counts as literal content.
    return { text: '', dropped: true }
  }
  // A single-line body may be a real path and must stay in the value:
  // dropping it once produced an empty argv element that path validation
  // resolved to the working directory while the shell touched the real target.
  return { text: trimmed, dropped: false }
}

// ─────────────────────────────────────────────────────────────────────────────
// Heredocs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a heredoc redirect and return its body text.
 *
 * Only quoted delimiters are accepted: an unquoted delimiter means the body
 * undergoes shell expansion, and the grammar does not even represent backtick
 * substitution inside an unquoted body as a node, so inspection cannot save
 * it. Anything attached to the redirect beyond its structural pieces is
 * material that followed the delimiter on the same command line — a pipe, a
 * redirect, an `&&` arm — and refuses so nothing is hidden from checks.
 */
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
        // A quoted-delimiter body is literal; only plain content children are
        // acceptable inside it.
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

// ─────────────────────────────────────────────────────────────────────────────
// Double-quoted strings
// ─────────────────────────────────────────────────────────────────────────────

type StringResolution = { value: string; sawLiteral: boolean; sawUnknown: boolean }

/**
 * Build a double-quoted string's value from its children, reconstructing the
 * literal newlines the parser drops (one per unit of byte gap between
 * children). The gap after the opening delimiter is filled; the gap just
 * before the closing delimiter is deliberately not (that is the
 * whitespace-only quirk, and newlines there would diverge from the shell).
 */
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
      if (i === 0) cursor = child.endIndex // opening delimiter: later gaps measure from it
      continue // the closing delimiter's gap is never filled
    }
    if (cursor !== null && child.startIndex > cursor) {
      const gap = child.startIndex - cursor
      value += '\n'.repeat(gap)
      sawLiteral = true // a filled gap counts as literal content
    }

    switch (child.type) {
      case 'string_content':
        value += removeDoubleQuoteEscapes(child.text)
        sawLiteral = true
        break
      case '$':
        // A standalone dollar sign is literal content.
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
        else sawLiteral = true // any non-marker result — even empty — is literal content
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
    // A substitution-only argument would flow into path validation as a
    // relative name and pass a check the runtime value would fail.
    throw new TooComplexError(
      'quoted argument consists entirely of runtime-determined content',
      node.type,
    )
  }
  if (!sawLiteral && !sawUnknown && node.text.length > 2) {
    // The parser attributes a whitespace-only quoted body to the closing
    // delimiter, so the computed value would be empty while the shell passes
    // whitespace.
    throw new TooComplexError(
      'whitespace-only quoted string cannot be analyzed faithfully',
      node.type,
    )
  }
  return { value, sawLiteral, sawUnknown }
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an argument node to its literal string value with quotes resolved.
 * Anything whose runtime value cannot be pinned down refuses.
 */
function resolveArgument(node: Node | null | undefined, scope: VariableScope, ctx: WalkContext): string {
  if (!node) {
    throw new TooComplexError('missing argument node')
  }
  switch (node.type) {
    case 'word':
      refuseOnBraceExpansion(node)
      // Unquoted quote removal: an escaped builtin name must still match the
      // builtin blocklists, and `find … {} \;` must yield `;` in argv.
      return removeBackslashEscapes(node.text)
    case 'number':
      if (node.children.length > 0) {
        // Base-prefixed arithmetic (`NN#…`) parses as a number whose child
        // may be a substitution; the flat text would smuggle it past checks.
        const child = node.children[0] as Node
        throw new TooComplexError(
          `number carries an embedded expansion (${child.type})`,
          child.type,
        )
      }
      return node.text
    case 'raw_string':
      // Strip the outer single quotes; the body is literal.
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
      // Contributed as its own source text: the shell replaces it with an
      // integer, which can never be the sensitive path or deny-pattern text.
      validateArithmetic(node)
      return node.text
    case 'simple_expansion':
      // A bare reference: the concatenation (or word) as a whole is the
      // argument, so bare-argument rules apply.
      return resolveVariableReference(node, scope, false).value
    default:
      throw refusalForNode(node)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// File redirects
// ─────────────────────────────────────────────────────────────────────────────

/** The canonical operator tokens a file redirect may carry. */
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

/**
 * Extract fd, operator and target from a file redirect node. A missing
 * operator or target refuses with the redirect node's own type reported.
 */
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
          // Same base-prefix smuggling hazard as arguments.
          throw refusalForNode(child.children[0] as Node)
        }
        refuseOnBraceExpansion(child)
        // Without unescaping, a target written with a stray backslash evades
        // path pattern checks while the shell opens the real path.
        target = removeBackslashEscapes(child.text)
        break
      case 'raw_string':
        target = child.text.slice(1, -1) // may legitimately be empty
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

// ─────────────────────────────────────────────────────────────────────────────
// Assignments
// ─────────────────────────────────────────────────────────────────────────────

type ValidatedAssignment = { name: string; value: string; append: boolean }

/** Characters allowed in a PS4 value once `${identifier}` references are stripped. */
const PS4_SAFE_VALUE_RE = /^[A-Za-z0-9 _+:./=[\]-]*$/
const PS4_REFERENCE_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g

/**
 * Validate one assignment node (bare statement, environment prefix, or
 * declaration child) into a name, value and append flag.
 */
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
        // The inner commands still run and must be rule-checked; the stored
        // value becomes the substitution marker.
        extractSubstitutionCommands(child, scope, ctx)
        value = SUBSTITUTION_MARKER
        break
      }
      case 'simple_expansion': {
        // Assignment right-hand sides neither word-split nor glob-expand, so
        // string rules apply; unknown values store the marker and the
        // composite rules take over at the point of use.
        value = resolveVariableReference(child, scope, true).value
        break
      }
      default:
        // A later child overwrites an earlier one rather than concatenating.
        value = resolveArgument(child, scope, ctx)
        break
    }
  }

  if (name === undefined) {
    throw new TooComplexError('variable assignment has no name', node.type)
  }
  if (!SHELL_IDENTIFIER_RE.test(name)) {
    // The parser accepts shapes the shell does not; the shell would try to
    // EXECUTE a digit-initial "assignment" as a command, so treating it as
    // inert would hide a command entirely.
    throw new TooComplexError(
      `assignment name ${JSON.stringify(name)} is not a valid shell identifier`,
      node.type,
    )
  }
  if (name === 'IFS') {
    // Changing the field separator changes word-splitting for every later
    // unquoted expansion; the bare-argument guard models only the default.
    throw new TooComplexError('assignment to IFS cannot be analyzed safely', node.type)
  }
  if (name === 'PS4') {
    // Allowlist, not blocklist: the trace prefix expands on every traced
    // command, and prompt escapes decode BEFORE expansion, so a blocklist
    // can be manufactured around.
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
    // Tilde expansion happens at assignment time, so the analyser would
    // record literal text while the shell stores an absolute path.
    throw new TooComplexError(
      'assignment value contains ~, which the shell may expand at assignment time',
      node.type,
    )
  }
  return { name, value, append }
}

/** Record a validated assignment in scope, honouring append semantics. */
function recordAssignment(scope: VariableScope, assignment: ValidatedAssignment): void {
  if (assignment.append) {
    scope.set(assignment.name, combineAppend(scope.get(assignment.name) ?? '', assignment.value))
  } else {
    scope.set(assignment.name, assignment.value)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source-text rebuilding
// ─────────────────────────────────────────────────────────────────────────────

/** A `$` followed by an identifier start: a resolved reference makes the raw span lie. */
const DOLLAR_REFERENCE_RE = /\$[A-Za-z_]/

/** Characters that force an argv element to be single-quoted in rebuilt text. */
const NEEDS_QUOTING_RE = /["'\\ \t\n$`;|&<>(){}*?[\]~#]/

function escapeArgvElement(element: string): string {
  if (element !== '' && !NEEDS_QUOTING_RE.test(element)) return element
  return `'${element.replace(/'/g, "'\\''")}'`
}

/**
 * Deny/allow rules match on command text, so when the raw span no longer
 * shows what actually runs — a resolved variable reference, or a newline
 * hiding a line continuation or heredoc body — the text is rebuilt from the
 * shell-escaped argv. Redirects and environment assignments are
 * intentionally not part of the rebuilt text.
 */
function commandTextForSpan(rawSpan: string, argv: string[]): string {
  if (DOLLAR_REFERENCE_RE.test(rawSpan) || rawSpan.includes('\n')) {
    return argv.map(escapeArgvElement).join(' ')
  }
  return rawSpan
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple commands
// ─────────────────────────────────────────────────────────────────────────────

function handleSimpleCommand(node: Node, scope: VariableScope, ctx: WalkContext): void {
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  const redirects: Redirect[] = []

  for (const child of node.children) {
    switch (child.type) {
      case 'variable_assignment': {
        // Environment-prefix assignments are command-local in the shell:
        // recorded as this command's environment, never into shared scope.
        // The append flag is discarded here — `VAR+=x cmd` records the
        // right-hand side alone.
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
        // The content is stdin, not argv: validate that it is statically
        // resolvable, scan it for the newline-then-comment pattern (it stays
        // in the source span but leaves argv), then discard it. An fd-prefixed
        // here-string (`cat 3<<< "hi"`) redirects a non-stdin descriptor — the
        // handler must NOT skip the leading file-descriptor child; refuse it.
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
        // Includes a bare command substitution at argument position: its
        // output IS the argument, and a placeholder would hide the real
        // path from validation.
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

// ─────────────────────────────────────────────────────────────────────────────
// Declaration commands
// ─────────────────────────────────────────────────────────────────────────────

const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set([
  'export',
  'local',
  'readonly',
  'declare',
  'typeset',
])

/** The declaration builtins whose flags/subscripts arithmetically evaluate. */
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
        // Two checks scoped to declare/typeset/local (export and readonly
        // treat the same spellings as inert or reject them before
        // evaluation), run against the RESOLVED argument so quoted and
        // escaped spellings are caught.
        if (SUBSCRIPT_SENSITIVE_DECLARATIONS.has(argv[0] ?? '')) {
          if (resolved.startsWith('-')) {
            const letterRun = /^-([A-Za-z]*)/.exec(resolved)?.[1] ?? ''
            if (/[niaA]/.test(letterRun)) {
              // A nameref makes the recorded name lie; integer/array
              // attributes arithmetically evaluate the right-hand side at
              // assignment time, even from single-quoted arguments.
              throw new TooComplexError(
                `declaration flag ${JSON.stringify(resolved)} creates a nameref, integer or array variable`,
                node.type,
              )
            }
          } else {
            const bracketIndex = resolved.indexOf('[')
            const equalsIndex = resolved.indexOf('=')
            if (bracketIndex !== -1 && (equalsIndex === -1 || bracketIndex < equalsIndex)) {
              // A bare positional with a subscript implicitly creates an
              // array element, and the shell arithmetically evaluates the
              // subscript.
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
        // Declaration assignments join the shared scope (append semantics
        // apply there); argv always renders the plain `name=value` form with
        // the right-hand side alone, even for `+=`.
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

// ─────────────────────────────────────────────────────────────────────────────
// Unset commands
// ─────────────────────────────────────────────────────────────────────────────

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
        // Removing the name makes a later reference to it refuse correctly.
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

// ─────────────────────────────────────────────────────────────────────────────
// Test commands
// ─────────────────────────────────────────────────────────────────────────────

/** Token leaves inside a test expression that contribute their own text to argv. */
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
  // Both bracket forms are one synthetic command whose argv[0] is the
  // double-bracket spelling; permission rules and the semantic checks key on
  // it. Normalising `[` to `[[` over-blocks slightly on the arithmetic
  // subscript check, which is the deliberate safe side.
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
        // Pattern text executes nothing; substitutions inside a pattern are
        // sibling nodes walked separately.
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

// ─────────────────────────────────────────────────────────────────────────────
// Redirected statements
// ─────────────────────────────────────────────────────────────────────────────

/** The only statement kinds a redirected statement may wrap. */
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
      // Heredocs contribute nothing to the redirect list; validation still
      // guards the delimiter and any smuggled same-line material.
      validateHeredocRedirect(child)
      continue
    }
    if (REDIRECTABLE_INNER_TYPES.has(child.type)) {
      inner = child // a later eligible child replaces an earlier one
      continue
    }
    // Every compound form — a redirected subshell, test command, loop,
    // conditional or brace group — refuses here even though the same
    // construct is accepted unredirected.
    throw refusalForNode(child)
  }

  if (!inner) {
    // A bare redirect such as `> file` truncates the file; downstream must
    // still see the write, so a command with empty argv carries it.
    ctx.commands.push({ argv: [], envVars: [], redirects, text: node.text })
    return
  }

  const before = ctx.commands.length
  walkNode(inner, scope, ctx)
  if (ctx.commands.length > before && redirects.length > 0) {
    // The last command produced is the one whose output is redirected.
    const last = ctx.commands[ctx.commands.length - 1] as SimpleCommand
    last.redirects.push(...redirects)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loops
// ─────────────────────────────────────────────────────────────────────────────

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
        // Iteration words produced by a substitution still run; extract and
        // rule-check them.
        extractSubstitutionCommands(child, scope, ctx)
        break
      default:
        // Every other iteration word is validated (a disallowed expansion
        // refuses) and its value discarded.
        resolveArgument(child, scope, ctx)
        break
    }
  }

  if (loopVariable === null || body === null) {
    throw new TooComplexError('loop is missing its variable or body', node.type)
  }
  if (loopVariable === 'IFS' || loopVariable === 'PS4') {
    // This path writes scope directly and would otherwise skip assignment
    // validation — a word-splitting bypass or code execution under tracing.
    throw new TooComplexError(
      `loop variable ${loopVariable} cannot be analyzed safely`,
      node.type,
    )
  }

  // Always runtime-unknown, even for static iteration words: a static word
  // may be an absolute path (hidden from path validation via the body), a
  // glob (expanded at runtime), or a flag (flag smuggling). Set in the REAL
  // scope — the variable remains set after the loop, as in the shell.
  scope.set(loopVariable, UNKNOWN_MARKER)

  // One copy shared across the body's statements: assignments carry between
  // them but never leak past the loop.
  const bodyScope = new Map(scope)
  for (const statement of body.children) {
    if (statement.type === 'do' || statement.type === 'done' || statement.type === ';') continue
    walkNode(statement, bodyScope, ctx)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conditionals and while loops
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a primary-condition child is collected, scan the commands it
 * appended: a `read` marks its bare identifier operands runtime-unknown in
 * the REAL scope so the body can interpolate them — but overwriting a
 * tracked pure literal fails closed, because the flat list cannot tell
 * whether that `read` was itself scope-isolated, and masking a literal
 * could hide path traversal.
 */
function trackConditionReads(commands: SimpleCommand[], scope: VariableScope, nodeType: string): void {
  for (const command of commands) {
    if (command.argv[0] !== 'read') continue
    for (const operand of command.argv.slice(1)) {
      if (operand.startsWith('-')) continue
      if (!SHELL_IDENTIFIER_RE.test(operand)) continue
      const existing = scope.get(operand)
      if (existing !== undefined && isLiteralValue(existing)) {
        // Carry the if-statement node type so the analytics id maps to the
        // if-statement entry rather than the empty-type sentinel.
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
        // One copy shared across the clause's statements; an elif clause's
        // own condition rides inside that copy and gets no read tracking.
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
          // Primary condition: always runs, so its assignments are
          // unconditional — the real scope, plus read tracking.
          const before = ctx.commands.length
          walkNode(child, scope, ctx)
          trackConditionReads(ctx.commands.slice(before), scope, node.type)
        } else {
          // Each then-branch statement gets its own fresh copy, so an
          // assignment does not even carry to the next statement in the
          // same branch.
          walkNode(child, new Map(scope), ctx)
        }
    }
  }
}

function handleWhileStatement(node: Node, scope: VariableScope, ctx: WalkContext): void {
  // The parser routes `until` through this same node kind.
  for (const child of node.children) {
    switch (child.type) {
      case 'while':
      case 'until':
      case ';':
        break
      case 'do_group': {
        // One copy shared across the body's statements, taken after the
        // condition so it already contains anything the condition tracked.
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
        // Everything outside the do-group is the primary condition.
        const before = ctx.commands.length
        walkNode(child, scope, ctx)
        trackConditionReads(ctx.commands.slice(before), scope, node.type)
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Statement lists and scope separators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk sibling statements, mirroring the shell's scope guarantees: `&&` and
 * `;` carry scope forward (the left side definitely ran); `||` and `&` do
 * not — the working scope restarts from a snapshot taken before the
 * structure was entered, and diverges from the caller's map from that point
 * on. The snapshot is only taken when a cheap pre-scan actually finds a
 * `||` or `&` token, which the overwhelmingly common command has none of.
 */
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

/**
 * Pipeline stages run in subshells: the walk starts from a copy of the
 * incoming scope, never mutates the caller's map, and restarts from that
 * untouched caller map on each stage separator.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// The walk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The allowlist dispatch. Any node type without an explicit handler refuses
 * — including the multi-assignment node for a bare `A=1 B=2`, the C-style
 * for loop, case statements and function definitions. No separate
 * error-node sweep is needed: `ERROR` falls through this same default.
 */
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
      // Inverting an exit status neither executes code nor changes argv.
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
      // A bare assignment executes nothing and needs no permission rule; it
      // is validated (so a substitution in the value is still extracted or
      // rejected) and recorded in scope, but no command is emitted.
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
      // Subshell commands run, so they are extracted — with a copy of the
      // scope, since their assignments never leak out. But a subshell body
      // whose statements are joined by a flat `;`/`&` separator arrives with
      // that separator as a direct child (unlike `&&`, which the parser wraps
      // in a list node): refuse it as too-complex rather than skipping the
      // separator the way the structural walker does.
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

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

// Contract data: this reason string is pinned byte-exact by the
// command-analysis corpus, and the node-type token is matched downstream.
const PARSE_ABORT_NODE_TYPE = 'PARSE_ABORT'
const PARSE_ABORT_REASON =
  'Parser aborted (timeout or resource limit) — possible adversarial input'

/**
 * Synchronous analysis over an already-parsed tree (or the parse-aborted
 * sentinel). Pre-checks still run on the raw string — they are the known
 * tokenization disagreements, so no tree is trusted before them.
 */
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
    // Aborts are adversarially reachable within the length limit; routing
    // them to the legacy fallback would lose the builtin checks entirely,
    // so this is never conflated with parse-unavailable.
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
    // Malformed input must never throw to the caller; an unexpected failure
    // grades the command too complex, which is the fail-closed direction.
    return {
      kind: 'too-complex',
      reason: `analysis failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Parse then analyse. This is the only producer of the parse-unavailable
 * outcome, returned for every null the parser yields (module unavailable,
 * disabled, or an over-length command) so the caller can take its own
 * conservative fallback. The exactly-empty string short-circuits before the
 * parser — deliberately without trimming, which would strip the Unicode
 * whitespace the pre-checks exist to reject.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Semantic checks
// ─────────────────────────────────────────────────────────────────────────────

/** Builtins whose flagged name operands arithmetically evaluate subscripts. */
const SUBSCRIPT_FLAGS_BY_BUILTIN: ReadonlyMap<string, readonly string[]> = new Map([
  ['test', ['-v', '-R']],
  ['[', ['-v', '-R']],
  ['[[', ['-v', '-R']],
  ['printf', ['-v']],
  ['read', ['-a']],
  ['unset', ['-v']],
  ['wait', ['-p']],
])

/** The `[[ ]]` operators that evaluate both operands arithmetically. */
const ARITHMETIC_COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
])

/** `read` flags that take data (not a name), whose operands must not be scanned. */
const READ_DATA_FLAGS: ReadonlySet<string> = new Set(['p', 'd', 'n', 'N', 't', 'u', 'i'])

/** zsh module builtins: shell internals that parse as plain commands. */
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

/** Builtins that evaluate their arguments as shell code (with three narrow carve-outs). */
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

/** jq flags that read programs or data from files (code execution / file reads). */
const JQ_SHORT_FILE_FLAG_RE = /^-(?:f|L)(?:$|[^A-Za-z])/
const JQ_LONG_FILE_FLAG_RE = /^--(?:from-file|rawfile|slurpfile|library-path)(?:$|=)/

/** A valid `timeout` duration: digits, optional fraction, optional unit suffix. */
const TIMEOUT_DURATION_RE = /^[0-9]+(?:\.[0-9]+)?[smhd]?$/
/** The separated-value charset for `timeout -k`/`-s` and their long forms. */
const TIMEOUT_VALUE_RE = /^[A-Za-z0-9_.+-]+$/

type StripOutcome = { argv: string[] } | { failReason: string }

/**
 * Peel transparent wrappers repeatedly so the wrapped command is what gets
 * checked. Unknown wrapper flags fail closed — an unlocatable wrapped
 * command must not leave the wrapper as the checked name. This logic is
 * deliberately inlined here rather than shared with the permission module,
 * to avoid a circular dependency.
 */
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
      if (i >= argv.length) break // the bare wrapper is inert
      const duration = argv[i] as string
      if (!TIMEOUT_DURATION_RE.test(duration)) {
        // The real tool parses durations far more liberally; failing open
        // here once hid `eval` behind `timeout .5`.
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
        // An arithmetic expansion is contributed as its own text: the shell
        // would expand it to a legacy priority and exec what follows, while
        // the checker would take the expansion text as the command name.
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
          // `-u` must consume a NAME operand. A trailing `-u` with nothing
          // after it leaves the wrapped command unlocatable — fail closed,
          // like every other unanalysable env flag.
          if (i + 1 >= argv.length) {
            failed = arg
            break
          }
          i += 2
          continue
        }
        if (arg.startsWith('-')) {
          // In particular the argv-splitting flag (a shell of its own) and
          // the directory/path-changing flags.
          failed = arg
          break
        }
        break // the wrapped command starts here
      }
      if (failed !== null) {
        return { failReason: `unrecognised env flag ${JSON.stringify(failed)} hides the wrapped command` }
      }
      if (i >= argv.length) break // env with nothing left is inert
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
          // Long options in separated form cannot be enumerated safely.
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

/** Scan a combined short-flag cluster the way `read` parses it: the first
 * data-flag letter takes the rest of the cluster as its value, or the next
 * argument when it is the cluster's last letter. Returns whether the next
 * argument is consumed as data. */
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

  // 1. No name at all (a bare redirect's empty argv): nothing to check.
  if (name === undefined) return null

  // 2. An unquoted empty expansion at command position makes the shell drop
  //    the field and run the NEXT word, skipping every builtin check below.
  if (name === '') {
    return 'command name is empty, so argv[0] may not reflect what the shell runs'
  }

  // 3. Defence in depth: a runtime-determined command name.
  if (!isLiteralValue(name)) {
    return 'command name is determined at runtime'
  }

  // 4. A fragment can never be a complete command.
  if (name.startsWith('-') || name.startsWith('|') || name.startsWith('&')) {
    return `argv starts with the incomplete fragment ${JSON.stringify(name)}`
  }

  // 5. Builtins that arithmetically evaluate `arr[EXPR]` subscripts in name
  //    operands — even from single-quoted arguments.
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

  // 6. `[[ a -eq b ]]` evaluates both operands arithmetically, recursively
  //    expanding subscripts. String comparison operators do not.
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

  // 7. `read` and `unset` treat every bare positional as a name, no flag
  //    required; `read`'s data-taking flag operands are skipped so a prompt
  //    string is not caught.
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

  // 8. A reserved word as argv[0] means the parser failed to recognise a
  //    compound command and produced nonsense argv.
  if (SHELL_KEYWORDS.has(name)) {
    return `reserved word ${JSON.stringify(name)} as a command name indicates a mis-parsed command`
  }

  // 9. A comment after a newline can hide arguments from path validation.
  //    This reads the command's own recorded values — both quoting styles are
  //    caught, and heredoc bodies were excluded from argv precisely so
  //    markdown headings do not trip it.
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

  // 10. jq: system() executes commands; the file flags read or execute
  //     arbitrary files.
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

  // 11. zsh module builtins are shell internals; name matching is the only
  //     way to catch them.
  if (ZSH_MODULE_BUILTINS.has(name)) {
    return `${name} is a zsh module builtin that can bypass security checks`
  }

  // 12. Builtins that evaluate arguments as shell code, with three narrow
  //     carve-outs (a carve-out continues to the remaining checks).
  if (ARGUMENT_EVALUATING_BUILTINS.has(name)) {
    if (name === 'command') {
      // `command -v`/`-V` as the FIRST argument is a POSIX existence check
      // that only prints paths; bare `command foo` still bypasses
      // function/alias lookup and fails.
      if (stripped[1] !== '-v' && stripped[1] !== '-V') {
        return 'command bypasses function and alias lookup, so the effective target cannot be validated'
      }
    } else if (name === 'fc') {
      // List mode is safe; the editor and re-execute modes both end in
      // running a command.
      for (const arg of stripped.slice(1)) {
        if (arg.startsWith('-') && !arg.startsWith('--') && /[es]/.test(arg)) {
          return 'fc in editor or re-execute mode runs the resulting command'
        }
      }
    } else if (name === 'compgen') {
      // -C executes a command, -F calls a function, -W word-expands its
      // argument (case-sensitive; -c and -f only list completions).
      for (const arg of stripped.slice(1)) {
        if (arg.startsWith('-') && !arg.startsWith('--') && /[CFW]/.test(arg)) {
          return 'compgen with -C, -F or -W executes code while generating completions'
        }
      }
    } else {
      return `${name} evaluates its arguments as shell code`
    }
  }

  // 13. Reading another process's environment can expose secrets.
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

/**
 * Run the semantic red-flag checks over an extracted command list, returning
 * the first failure across all commands in command order. These checks are
 * about what the argv MEANS, not whether it could be tokenized.
 */
export function checkSemantics(commands: SimpleCommand[]): SemanticCheckResult {
  for (const command of commands) {
    const failure = checkOneCommand(command)
    if (failure !== null) {
      return { ok: false, reason: failure }
    }
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics node-type ids
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stable small-integer ids for node types (the analytics channel does not
 * accept strings): missing/empty → -2, the error node → -1, a
 * known-dangerous type → its 1-based position in that list, anything else →
 * 0. The list is append-only so existing ids never move.
 */
export function nodeTypeId(nodeType?: string): number {
  if (!nodeType) return -2
  if (nodeType === 'ERROR') return -1
  const index = DANGEROUS_NODE_TYPES.indexOf(nodeType)
  return index === -1 ? 0 : index + 1
}
