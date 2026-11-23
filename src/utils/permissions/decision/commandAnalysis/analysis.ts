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

type QuoteContext = {
  withDoubleQuotes: string
  fullyUnquoted: string
  unquotedKeepQuoteChars: string
}

type CompoundStructure = {
  hasCompoundOperators: boolean
  hasPipeline: boolean
  hasSubshell: boolean
  hasCommandGroup: boolean
  operators: string[]
  segments: string[]
}

type DangerousPatterns = {
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

function extractQuoteContext(rootNode: unknown, command: string): QuoteContext {
  const root = asNode(rootNode)
  if (!root) {
    return {
      withDoubleQuotes: command,
      fullyUnquoted: command,
      unquotedKeepQuoteChars: command,
    }
  }
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
        for (const child of node.children) visit(child)
        return
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

  const deleteRanges: Array<{ start: number; end: number }> = []
  for (const span of spans) {
    if (span.kind === 'double') {
      if (command[span.start] === '"') deleteRanges.push({ start: span.start, end: span.start + 1 })
      if (span.end > span.start + 1 && command[span.end - 1] === '"') {
        deleteRanges.push({ start: span.end - 1, end: span.end })
      }
    } else {
      deleteRanges.push({ start: span.start, end: span.end })
    }
  }
  deleteRanges.sort((a, b) => a.start - b.start || a.end - b.end)
  const mergedDeletes: Array<{ start: number; end: number }> = []
  for (const range of deleteRanges) {
    const prev = mergedDeletes[mergedDeletes.length - 1]
    if (prev && range.start <= prev.end) {
      if (range.end > prev.end) prev.end = range.end
    } else {
      mergedDeletes.push({ start: range.start, end: range.end })
    }
  }
  let withDoubleQuotes = command
  for (let i = mergedDeletes.length - 1; i >= 0; i--) {
    const range = mergedDeletes[i]!
    withDoubleQuotes = withDoubleQuotes.slice(0, range.start) + withDoubleQuotes.slice(range.end)
  }

  const outerSpans = dropContainedSpans(spans).sort((a, b) => b.start - a.start)
  let fullyUnquoted = command
  let unquotedKeepQuoteChars = command
  for (const span of outerSpans) {
    fullyUnquoted = fullyUnquoted.slice(0, span.start) + fullyUnquoted.slice(span.end)
    const replacement = span.kind === 'double' ? '""' : span.kind === 'ansiC' ? "$''" : "''"
    unquotedKeepQuoteChars =
      unquotedKeepQuoteChars.slice(0, span.start) + replacement + unquotedKeepQuoteChars.slice(span.end)
  }

  return { withDoubleQuotes, fullyUnquoted, unquotedKeepQuoteChars }
}

const OPERATOR_TYPES: ReadonlySet<string> = new Set(['&&', '||', ';', '|', '|&', '&'])

function extractCompoundStructure(rootNode: unknown, command: string): CompoundStructure {
  const result: CompoundStructure = {
    hasCompoundOperators: false,
    hasPipeline: false,
    hasSubshell: false,
    hasCommandGroup: false,
    operators: [],
    segments: [],
  }
  const root = asNode(rootNode)
  if (!root) {
    result.segments.push(command)
    return result
  }
  const visit = (node: Node): void => {
    switch (node.type) {
      case '&&':
      case '||':
      case ';':
        result.operators.push(node.type)
        break
      case 'list':
      case 'redirected_statement':
      case 'negated_command':
      case 'if_statement':
      case 'while_statement':
      case 'for_statement':
      case 'c_style_for_statement':
      case 'case_statement':
      case 'function_definition':
      case 'do_group':
      case 'elif_clause':
      case 'else_clause':
      case 'case_item':
        for (const child of node.children) visit(child)
        break
      case 'pipeline':
        result.hasPipeline = true
        for (const child of node.children) visit(child)
        break
      case 'subshell':
        result.hasSubshell = true
        for (const child of node.children) visit(child)
        break
      case 'compound_statement':
        result.hasCommandGroup = true
        for (const child of node.children) visit(child)
        break
      case 'command':
      case 'declaration_command':
      case 'variable_assignment':
        result.segments.push(node.text)
        break
      default:
        break
    }
  }
  for (const child of root.children) visit(child)
  if (result.segments.length === 0) result.segments.push(command)
  result.hasCompoundOperators = result.operators.length > 0
  return result
}

function hasActualOperatorNodes(rootNode: unknown): boolean {
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

function extractDangerousPatterns(rootNode: unknown): DangerousPatterns {
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
