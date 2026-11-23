import { wordListFault, type Node } from '../../../bash/parser.js'
import type { Redirect, SimpleCommand } from './reading.js'
import { childOfKind, GLOB_ITEM, heredocBody, IDENTIFIER_RE, integerValued, isKnown, LOOKUP_VARIABLE, NEWLINE_COMMENT_RE, Refusal, refuse, refuseNode, refuseWordListFault, substitutionStatements, UNKNOWN_INTEGER, UNKNOWN_VALUE, WordWalk, type Assignment, type Operand, type Scope } from './exactWords.js'

function appended(existing: string, added: string): string {
  if (!isKnown(existing) || !isKnown(added)) return UNKNOWN_VALUE
  return existing + added
}

const DOLLAR_REFERENCE_RE = /\$[A-Za-z_]/
const NEEDS_QUOTING_RE = /["'\\ \t\n$`;|&<>(){}*?[\]~#]/

export function quoteArgv(element: string): string {
  if (element !== '' && !NEEDS_QUOTING_RE.test(element)) return element
  return `'${element.replace(/'/g, "'\\''")}'`
}

function commandText(span: string, argv: string[]): string {
  if (DOLLAR_REFERENCE_RE.test(span) || span.includes('\n')) return argv.map(quoteArgv).join(' ')
  return span
}

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

function assign(scope: Scope, assignment: Assignment): void {
  if (assignment.append) {
    scope.set(assignment.name, appended(scope.get(assignment.name) ?? UNKNOWN_VALUE, assignment.value))
  } else {
    scope.set(assignment.name, assignment.value)
  }
}

const VARIABLE_WRITERS: ReadonlySet<string> = new Set(['read', 'printf', 'getopts', 'wait'])
const FOR_LITERAL_ITEMS_CAP = 64
const SEQ_ARGUMENT_RE = /^-?[0-9]+$/

function sequenceItems(commands: readonly SimpleCommand[]): string[] | null {
  const [command] = commands
  if (commands.length !== 1 || command === undefined || command.argv[0] !== 'seq' || command.envVars.length > 0 || command.redirects.length > 0 || command.globOperand) return null
  const numbers = command.argv.slice(1)
  if (numbers.length === 0 || numbers.length > 3 || !numbers.every(text => SEQ_ARGUMENT_RE.test(text))) return null
  const values = numbers.map(Number)
  const [first, increment, last] = values.length === 1 ? [1, 1, values[0]!] : values.length === 2 ? [values[0]!, 1, values[1]!] : [values[0]!, values[1]!, values[2]!]
  if (increment === 0 || (increment > 0 ? first > last : first < last)) return null
  const items: string[] = []
  for (let value = first; increment > 0 ? value <= last : value >= last; value += increment) {
    if (items.length >= FOR_LITERAL_ITEMS_CAP) return null
    items.push(String(value))
  }
  return items
}

function commandMayWriteVariables(node: Node): boolean {
  const nameNode = childOfKind(node, 'command_name')
  const inner = nameNode?.children.length === 1 ? (nameNode.children[0] as Node) : undefined
  if (inner === undefined || inner.type !== 'word' || inner.children.length > 0) return true
  return VARIABLE_WRITERS.has(inner.text) || inner.text === 'time' || EVALUATING_BUILTINS.has(inner.text)
}

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
      if (operand === '-v' && operands[i + 1] !== undefined) written.push(operands[++i] as string)
      else if (operand.startsWith('-v') && operand.length > 2) written.push(operand.slice(2))
      else break
    }
  }
  if (name === 'getopts') {
    const destination = operands[operands[0] === '--' ? 2 : 1]
    if (destination !== undefined) written.push(destination)
    written.push('OPTARG', 'OPTIND')
  }
  return written.map(variable => variable.replace(/\[.*$/, '')).filter(variable => IDENTIFIER_RE.test(variable))
}

abstract class CommandWalk extends WordWalk {
  readonly commands: SimpleCommand[] = []

  abstract node(node: Node, scope: Scope): void

  command(node: Node, scope: Scope): void {
    refuseWordListFault(wordListFault(node), node.type)
    const envVars: Array<{ name: string; value: string }> = []
    const argv: string[] = []
    const redirects: Redirect[] = []
    const operand: Operand = { glob: false }

    for (const child of node.children) {
      switch (child.type) {
        case 'variable_assignment': {
          const assigned = this.assignment(child, scope)
          envVars.push({ name: assigned.name, value: assigned.value })
          break
        }
        case 'command_name':
          if (child.children.length === 0) refuseNode(child)
          argv.push(this.argument(child.children[0], scope))
          break
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation':
        case 'arithmetic_expansion':
        case 'expansion':
        case 'simple_expansion':
          argv.push(this.argument(child, scope, operand))
          break
        case 'file_redirect':
          redirects.push(this.redirect(child, scope))
          break
        case 'command_substitution':
          if (
            argv[0] === 'rm' &&
            argv.slice(1).some(arg => arg === '--recursive' || (/^-[^-]/.test(arg) && /[rR]/.test(arg.slice(1))))
          ) {
            refuse('a command substitution feeds a recursive delete; run it with the path spelled out, or approve', child.type)
          }
          refuseNode(child)
        case 'herestring_redirect':
          for (const part of child.children) {
            if (part.type === '<<<') continue
            if (part.type === 'file_descriptor') refuseNode(part)
            const body = this.argument(part, scope)
            if (NEWLINE_COMMENT_RE.test(body)) {
              refuse('here-string content contains a newline followed by a comment', child.type)
            }
          }
          break
        default:
          refuseNode(child)
      }
    }

    const command: SimpleCommand = operand.glob
      ? { argv, envVars, redirects, text: commandText(node.text, argv), globOperand: true }
      : { argv, envVars, redirects, text: commandText(node.text, argv) }
    this.commands.push(command)

    for (const variable of writtenVariables(argv)) {
      if (LOOKUP_VARIABLE.test(variable) || variable === 'IFS' || variable === 'PS4') {
        refuse(`${argv[0]} writes ${variable}, changing shell lookup or expansion; use a different variable, or approve`, node.type)
      }
      scope.set(variable, UNKNOWN_VALUE)
    }
  }

  declaration(node: Node, scope: Scope): void {
    refuseWordListFault(wordListFault(node), node.type)
    const argv: string[] = []
    let keyword = ''
    let endOfFlags = false

    for (const child of node.children) {
      if (DECLARATION_WORDS.has(child.type)) {
        keyword = child.type
        if (child.type === 'local' || child.type === 'readonly') {
          refuse(`${child.text} changes whether later variable assignments take effect; use a plain assignment in this command, or approve`, node.type)
        }
        argv.push(child.text)
        continue
      }
      if (child.type === 'variable_assignment') {
        const assigned = this.assignment(child, scope)
        assign(scope, assigned)
        argv.push(`${assigned.name}=${assigned.value}`)
        continue
      }
      if (child.type === 'variable_name') {
        argv.push(child.text)
        continue
      }
      switch (child.type) {
        case 'word':
        case 'number':
        case 'raw_string':
        case 'string':
        case 'concatenation':
        case 'arithmetic_expansion':
        case 'expansion':
        case 'simple_expansion': {
          const value = this.argument(child, scope)
          if (!endOfFlags && (value.startsWith('-') || value.startsWith('+'))) {
            if (value === '--') {
              endOfFlags = true
            } else {
              if (SUBSCRIPT_DECLARATIONS.has(keyword) && value.startsWith('-')) {
                if (/[niaA]/.test(value.slice(1))) {
                  refuse(`declaration flag ${JSON.stringify(value)} creates a nameref, integer or array variable`, node.type)
                }
                if (/[luc]/.test(value.slice(1))) {
                  refuse(`declaration flag ${JSON.stringify(value)} rewrites the case of the values it declares, so a tracked value no longer names what runs; drop the flag, or approve`, node.type)
                }
              }
              const allowed = keyword === 'export' ? /^-[np]+$/ : /^-[xg]+$/
              if (!allowed.test(value)) {
                refuse(`declaration flag ${JSON.stringify(value)} can change or prevent assignment; use a plain assignment, or approve`, node.type)
              }
            }
          } else if (SUBSCRIPT_DECLARATIONS.has(keyword)) {
            const eq = value.indexOf('=')
            const head = eq === -1 ? value : value.slice(0, eq)
            if (head.includes('[')) {
              refuse(`declaration operand ${JSON.stringify(value)} carries an array subscript`, node.type)
            }
          }
          argv.push(value)
          break
        }
        default:
          refuseNode(child)
      }
    }

    this.commands.push({ argv, envVars: [], redirects: [], text: commandText(node.text, argv) })
  }

  unset(node: Node, scope: Scope): void {
    refuseWordListFault(wordListFault(node), node.type)
    const argv: string[] = []
    for (const child of node.children) {
      if (child.type === 'unset' || child.type === 'unsetenv') {
        argv.push(child.text)
      } else if (child.type === 'variable_name') {
        scope.delete(child.text)
        argv.push(child.text)
      } else if (child.type === 'word') {
        argv.push(this.argument(child, scope))
      } else {
        refuseNode(child)
      }
    }
    this.commands.push({ argv, envVars: [], redirects: [], text: commandText(node.text, argv) })
  }

  test(node: Node, scope: Scope): void {
    const argv: string[] = ['[[']
    const visit = (current: Node): void => {
      for (const child of current.children) {
        if (child.type === '[[' || child.type === ']]' || child.type === '[' || child.type === ']') continue
        if (
          child.type === 'binary_expression' ||
          child.type === 'unary_expression' ||
          child.type === 'parenthesized_expression' ||
          child.type === 'negated_command'
        ) {
          visit(child)
          continue
        }
        if (
          child.type === 'test_operator' ||
          child.type === 'regex' ||
          child.type === 'extglob_pattern' ||
          TEST_TOKENS.has(child.type)
        ) {
          argv.push(child.text)
          continue
        }
        argv.push(this.argument(child, scope))
      }
    }
    visit(node)
    this.commands.push({ argv, envVars: [], redirects: [], text: commandText(node.text, argv) })
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
}

abstract class FlowWalk extends CommandWalk {
  abstract invalidateAssignments(node: Node, scope: Scope): void

  loop(node: Node, scope: Scope): void {
    let select = false
    let variable: string | undefined
    let body: Node | undefined
    let seenIn = false
    const itemNodes: Node[] = []

    for (const child of node.children) {
      if (child.type === 'for') continue
      if (child.type === 'select') {
        select = true
        continue
      }
      if (child.type === 'variable_name' && variable === undefined) {
        variable = child.text
        continue
      }
      if (child.type === 'in') {
        seenIn = true
        continue
      }
      if (child.type === 'do_group') {
        body = child
        continue
      }
      if (child.type === ';' || child.type === '\n') continue
      if (seenIn) itemNodes.push(child)
    }

    if (!variable || !body) refuse('loop is missing its variable or body', node.type)
    if (variable === 'IFS' || variable === 'PS4') refuse(`loop variable ${variable} cannot be analyzed safely`, node.type)
    if (LOOKUP_VARIABLE.test(variable)) {
      refuse(`loop variable ${variable} changes shell lookup, path expansion or startup code; use a different variable, or approve`, node.type)
    }

    const hasUnquotedTilde = (item: Node): boolean =>
      (item.type === 'word' && item.text.startsWith('~')) ||
      (item.type === 'concatenation' && item.children.length > 0 && hasUnquotedTilde(item.children[0]!))

    let items: string[] | null = !select && seenIn && itemNodes.length > 0 ? [] : null

    for (const item of itemNodes) {
      if (item.type === 'command_substitution') {
        const before = this.commands.length
        this.substitution(item, scope)
        const emitted = this.commands.slice(before)
        if (items === null) continue
        const expanded = sequenceItems(emitted)
        if (expanded === null) {
          items = null
          continue
        }
        items.push(...expanded)
        if (items.length > FOR_LITERAL_ITEMS_CAP) items = null
        continue
      }

      const operand: Operand = { glob: false }
      const value = this.argument(item, scope, operand)
      if (!isKnown(value) || hasUnquotedTilde(item)) {
        items = null
      } else if (items !== null) {
        items.push(operand.glob ? `${GLOB_ITEM}${value}` : value)
        if (items.length > FOR_LITERAL_ITEMS_CAP) items = null
      }
    }

    const bodyScope = new Map(scope)
    this.invalidateAssignments(body, bodyScope)
    this.invalidateAssignments(body, scope)
    if (items === null) {
      bodyScope.set(variable, UNKNOWN_VALUE)
      this.body(body, bodyScope)
      for (const [name, value] of bodyScope) {
        if (!scope.has(name)) scope.set(name, value === UNKNOWN_INTEGER ? UNKNOWN_INTEGER : UNKNOWN_VALUE)
      }
    } else {
      for (const item of items) {
        const iteration = new Map(bodyScope)
        iteration.set(variable, item)
        this.body(body, iteration)
        for (const [name, value] of iteration) {
          if (name === variable) continue
          if (!scope.has(name) || (!isKnown(value) && value !== scope.get(name))) {
            scope.set(name, value === UNKNOWN_INTEGER ? UNKNOWN_INTEGER : UNKNOWN_VALUE)
          }
        }
      }
    }
    scope.set(variable, UNKNOWN_VALUE)
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

export class Walk extends FlowWalk {
  invalidateAssignments(node: Node, scope: Scope): void {
    if (node.type === 'subshell' || node.type === 'command_substitution') return
    if (node.type === 'variable_assignment') {
      const name = childOfKind(node, 'variable_name')?.text
      const value = node.children.find(child => child.type !== 'variable_name' && child.type !== '=' && child.type !== '+=')
      const previous = scope.get(name ?? '')
      const integer = value !== undefined && (value.type === 'arithmetic_expansion' || (value.type === 'number' && value.children.length === 0)) && (previous === undefined || integerValued(previous))
      if (name !== undefined) scope.set(name, integer ? UNKNOWN_INTEGER : UNKNOWN_VALUE)
    }
    if (node.type === 'unset_command') {
      for (const child of node.children) {
        if (child.type === 'variable_name') scope.set(child.text, UNKNOWN_VALUE)
        else if (child.type !== 'unset' && child.type !== 'unsetenv') for (const name of scope.keys()) scope.set(name, UNKNOWN_VALUE)
      }
    }
    if (node.type === 'for_statement') {
      const name = childOfKind(node, 'variable_name')?.text
      if (name !== undefined) scope.set(name, UNKNOWN_VALUE)
    }
    if (node.type === 'command' && commandMayWriteVariables(node)) {
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
        this.statements(node.children, scope)
        return
      case 'list':
        this.chain(node, scope)
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
      case 'compound_statement':
        this.statements(node.children.filter(child => child.type !== '{' && child.type !== '}'), scope)
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
    const chain = children.some(child => child.type === '||' || child.type === '&&')
    if (chain) {
      this.chain({ type: 'list', text: children.map(child => child.text).join(' '), startIndex: children[0]?.startIndex ?? 0, endIndex: children.at(-1)?.endIndex ?? 0, children }, scope)
      return
    }
    for (const child of children) {
      switch (child.type) {
        case ';':
        case '\n':
          break
        case '&':
          refuse('the background operator & starts work outside the foreground command; run it in the foreground, or approve', child.type)
        default:
          this.node(child, scope)
      }
    }
  }

  chain(node: Node, scope: Scope): void {
    const items: Node[] = []
    const operators: string[] = []
    const flatten = (list: Node): void => {
      for (const child of list.children) {
        if (child.type === 'list') flatten(child)
        else if (child.type === '&&' || child.type === '||') operators.push(child.type)
        else if (child.type === '&') refuse('the background operator & starts work outside the foreground command; run it in the foreground, or approve', child.type)
        else if (child.type !== '\n' && child.type !== ';' && child.type !== 'comment') items.push(child)
      }
    }
    flatten(node)
    if (items.length !== operators.length + 1) refuse('the shell parser cannot establish the order of this list; split it into explicit commands, or approve', node.type)
    const after: Scope[] = []
    for (let index = 0; index < items.length; index++) {
      let current: Scope
      if (index === 0) current = new Map(scope)
      else if (index === 1 || operators[index - 2] === operators[index - 1]) current = new Map(after[index - 1] as Scope)
      else {
        current = new Map(after[0] as Scope)
        for (let earlier = 1; earlier < index; earlier++) this.invalidateAssignments(items[earlier] as Node, current)
      }
      this.node(items[index] as Node, current)
      after.push(current)
    }
    const settled = new Map(after[0] as Scope)
    for (let index = 1; index < items.length; index++) this.invalidateAssignments(items[index] as Node, settled)
    scope.clear()
    for (const [name, value] of settled) scope.set(name, value)
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
    this.statements(node.children.filter(child => child.type !== '(' && child.type !== ')'), new Map(scope))
  }

  substitution(node: Node, scope: Scope): void {
    this.statements(substitutionStatements(node), new Map(scope))
  }
}

export const READ_DATA_FLAGS: ReadonlySet<string> = new Set(['p', 'd', 'n', 'N', 't', 'u', 'i'])

export const EVALUATING_BUILTINS: ReadonlySet<string> = new Set([
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
