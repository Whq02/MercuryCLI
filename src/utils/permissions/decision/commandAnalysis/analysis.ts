import { notBuilt, unbuilt, type Unbuilt } from '../../../../pi/holes.js'

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

type QuoteContext = Unbuilt

type CompoundStructure = Unbuilt

type DangerousPatterns = Unbuilt

export type TreeSitterAnalysis = Unbuilt

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
  return notBuilt('src/utils/permissions/decision/commandAnalysis/analysis.ts:95')
}

const OPERATOR_TYPES: ReadonlySet<string> = unbuilt('src/utils/permissions/decision/commandAnalysis/analysis.ts:138')

function extractCompoundStructure(rootNode: unknown, command: string): CompoundStructure {
  return notBuilt('src/utils/permissions/decision/commandAnalysis/analysis.ts:140')
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
