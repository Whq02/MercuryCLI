
type Node = {
  type: string
  text: string
  startIndex: number
  endIndex: number
  children: Node[]
}

function asNode(value: unknown): Node | null {
  if (value && typeof value === 'object' && 'type' in value && 'children' in value) {
    return value as Node
  }
  return null
}

export type QuoteContext = {
  withDoubleQuotes: string
  fullyUnquoted: string
  unquotedKeepQuoteChars: string
}

export type CompoundStructure = {
  hasCompoundOperators: boolean
  hasPipeline: boolean
  hasSubshell: boolean
  hasCommandGroup: boolean
  operators: string[]
  segments: string[]
}

export type DangerousPatterns = {
  hasCommandSubstitution: boolean
  hasProcessSubstitution: boolean
  hasParameterExpansion: boolean
  hasHeredoc: boolean
  hasComment: boolean
}

export type TreeSitterAnalysis = {
  quoteContext: QuoteContext
  compoundStructure: CompoundStructure
  dangerousPatterns: DangerousPatterns
  hasActualOperatorNodes: boolean
}

type QuotedSpan = { start: number; end: number; kind: 'single' | 'double' | 'ansiC' | 'quotedHeredoc' }

function heredocIsQuoted(node: Node): boolean {
  const start = node.children.find(child => child.type === 'heredoc_start')
  const first = start?.text[0]
  return first === "'" || first === '"' || first === '\\'
}

function collectQuotedSpans(root: Node): QuotedSpan[] {
  const spans: QuotedSpan[] = []
  const visit = (node: Node): void => {
    switch (node.type) {
      case 'raw_string':
        spans.push({ start: node.startIndex, end: node.endIndex, kind: 'single' })
        return
      case 'ansi_c_string':
        spans.push({ start: node.startIndex, end: node.endIndex, kind: 'ansiC' })
        return
      case 'string':
        spans.push({ start: node.startIndex, end: node.endIndex, kind: 'double' })
        break
      case 'heredoc_redirect':
        if (heredocIsQuoted(node)) {
          spans.push({ start: node.startIndex, end: node.endIndex, kind: 'quotedHeredoc' })
          return
        }
        break
      default:
        break
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return spans
}

function dropContainedSpans(spans: QuotedSpan[]): QuotedSpan[] {
  return spans.filter(
    span =>
      !spans.some(
        other =>
          other !== span &&
          other.start <= span.start &&
          other.end >= span.end &&
          !(other.start === span.start && other.end === span.end),
      ),
  )
}

export function extractQuoteContext(rootNode: unknown, command: string): QuoteContext {
  const root = asNode(rootNode)
  if (!root) {
    return { withDoubleQuotes: command, fullyUnquoted: command, unquotedKeepQuoteChars: command }
  }

  const rawSpans = collectQuotedSpans(root)

  const doubleSpans = rawSpans.filter(s => s.kind === 'double')
  const removeSpans = rawSpans.filter(s => s.kind !== 'double')
  let withDoubleQuotes = ''
  for (let i = 0; i < command.length; i++) {
    if (removeSpans.some(s => i >= s.start && i < s.end)) continue
    if (doubleSpans.some(s => i === s.start || i === s.end - 1)) continue
    withDoubleQuotes += command[i]
  }

  const spliceSpans = dropContainedSpans(rawSpans).sort((a, b) => b.start - a.start)
  let fullyUnquoted = command
  let unquotedKeepQuoteChars = command
  for (const span of spliceSpans) {
    fullyUnquoted = fullyUnquoted.slice(0, span.start) + fullyUnquoted.slice(span.end)
    let replacement: string
    switch (span.kind) {
      case 'single':
        replacement = "''"
        break
      case 'double':
        replacement = '""'
        break
      case 'ansiC':
        replacement = "$''"
        break
      default:
        replacement = ''
    }
    unquotedKeepQuoteChars =
      unquotedKeepQuoteChars.slice(0, span.start) + replacement + unquotedKeepQuoteChars.slice(span.end)
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

const OPERATOR_TYPES: ReadonlySet<string> = new Set([';', '&&', '||'])

export function extractCompoundStructure(rootNode: unknown, command: string): CompoundStructure {
  const root = asNode(rootNode)
  const operators: string[] = []
  const segments: string[] = []
  let hasPipeline = false
  let hasSubshell = false
  let hasCommandGroup = false

  if (!root) {
    return {
      hasCompoundOperators: false,
      hasPipeline: false,
      hasSubshell: false,
      hasCommandGroup: false,
      operators: [],
      segments: [command],
    }
  }

  const redispatch = (node: Node): void => classifyChildren(node)
  const descend = (node: Node): void => {
    for (const child of node.children) classifyChild(child, false)
  }

  function classifyChild(child: Node, insideList: boolean): void {
    switch (child.type) {
      case '&&':
      case '||':
        operators.push(child.type)
        return
      case ';':
        if (insideList) {
          segments.push(child.text)
        } else {
          operators.push(';')
        }
        return
      case 'list':
        redispatch(child)
        return
      case 'redirected_statement': {
        const inner = child.children.filter(c => c.type !== 'file_redirect')
        if (inner.length === 0) {
          segments.push(child.text)
        } else {
          for (const node of inner) redispatch(node)
        }
        return
      }
      case 'pipeline':
        hasPipeline = true
        segments.push(child.text)
        return
      case 'subshell':
        hasSubshell = true
        segments.push(child.text)
        return
      case 'compound_statement':
        hasCommandGroup = true
        segments.push(child.text)
        return
      case 'negated_command':
        segments.push(child.text)
        descend(child)
        return
      case 'if_statement':
      case 'while_statement':
      case 'for_statement':
      case 'case_statement':
      case 'function_definition':
        segments.push(child.text)
        descend(child)
        return
      case 'command':
      case 'declaration_command':
      case 'variable_assignment':
        segments.push(child.text)
        return
      default:
        if (insideList) segments.push(child.text)
        return
    }
  }

  function classifyChildren(node: Node): void {
    const insideList = node.type === 'list'
    for (const child of node.children) classifyChild(child, insideList)
  }

  classifyChildren(root)

  if (segments.length === 0) segments.push(command)

  return {
    hasCompoundOperators: operators.length > 0,
    hasPipeline,
    hasSubshell,
    hasCommandGroup,
    operators,
    segments,
  }
}

export function hasActualOperatorNodes(rootNode: unknown): boolean {
  const root = asNode(rootNode)
  if (!root) return false
  const stack: Node[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Node
    if (OPERATOR_TYPES.has(node.type) || node.type === 'list') return true
    for (const child of node.children) stack.push(child)
  }
  return false
}

export function extractDangerousPatterns(rootNode: unknown): DangerousPatterns {
  const root = asNode(rootNode)
  const result: DangerousPatterns = {
    hasCommandSubstitution: false,
    hasProcessSubstitution: false,
    hasParameterExpansion: false,
    hasHeredoc: false,
    hasComment: false,
  }
  if (!root) return result
  const visit = (node: Node): void => {
    switch (node.type) {
      case 'command_substitution':
        result.hasCommandSubstitution = true
        break
      case 'process_substitution':
        result.hasProcessSubstitution = true
        break
      case 'expansion':
        result.hasParameterExpansion = true
        break
      case 'heredoc_redirect':
        result.hasHeredoc = true
        break
      case 'comment':
        result.hasComment = true
        break
      default:
        break
    }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return result
}

export function analyzeCommand(rootNode: unknown, command: string): TreeSitterAnalysis {
  return {
    quoteContext: extractQuoteContext(rootNode, command),
    compoundStructure: extractCompoundStructure(rootNode, command),
    dangerousPatterns: extractDangerousPatterns(rootNode),
    hasActualOperatorNodes: hasActualOperatorNodes(rootNode),
  }
}
