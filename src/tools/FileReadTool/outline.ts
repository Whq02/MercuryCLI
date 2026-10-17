import {
  languageForFile,
  loadGrammarEngine,
  parsePolyglot,
  type TSNode,
} from '../../services/structure/grammarFacility.js'
import { runtimeKernel } from '../../services/primitives/runtimeKernel.js'
import { addAnchoredLineNumbers } from '../../services/changeTransaction/lineAnchors.js'
import { addLineNumbers } from '../../utils/file.js'

const OUTLINE_MAX_BYTES = 2 * 1024 * 1024
const OUTLINE_MAX_LINES = 20_000
const OUTLINE_CACHE_CAP = 48

const FUNCTION_LIKE_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'function_item',
  'function',
  'arrow_function',
  'generator_function_declaration',
  'generator_function',
  'method_definition',
  'method_declaration',
  'method',
  'singleton_method',
  'constructor_declaration',
  'init_declaration',
])

const BODY_NODE_TYPES = new Set([
  'statement_block',
  'block',
  'compound_statement',
  'function_body',
  'body_statement',
])

type ElidedSpan = { startLine: number; endLine: number }

const outlineCache = new Map<string, string>()

function rememberOutline(key: string, value: string): string {
  if (outlineCache.has(key)) outlineCache.delete(key)
  outlineCache.set(key, value)
  if (outlineCache.size > OUTLINE_CACHE_CAP) {
    const oldest = outlineCache.keys().next().value
    if (oldest !== undefined) outlineCache.delete(oldest)
  }
  return value
}

function collectElidedSpans(root: TSNode, languageName: string): ElidedSpan[] {
  const raw: ElidedSpan[] = []
  const stack: TSNode[] = [root]
  let visited = 0
  while (stack.length > 0 && visited < 100_000) {
    const node = stack.pop()!
    visited++
    if (FUNCTION_LIKE_TYPES.has(node.type)) {
      const body = node.namedChildren.find(child => BODY_NODE_TYPES.has(child.type))
      if (body) {
        const bodyStartLine = body.startPosition.row + 1
        const bodyEndLine = body.endPosition.row + 1
        if (languageName === 'python') {
          const sigEndLine = Math.max(node.startPosition.row + 1, bodyStartLine - 1)
          const elideStart = Math.max(sigEndLine + 1, bodyStartLine)
          if (bodyEndLine >= elideStart) {
            raw.push({ startLine: elideStart, endLine: bodyEndLine })
            continue
          }
        } else if (languageName === 'ruby') {
          const elideStart = bodyStartLine
          const elideEnd = bodyEndLine
          if (elideEnd >= elideStart) {
            raw.push({ startLine: elideStart, endLine: elideEnd })
            continue
          }
        } else {
          const elideStart = bodyStartLine + 1
          const elideEnd = bodyEndLine - 1
          if (elideEnd >= elideStart) {
            raw.push({ startLine: elideStart, endLine: elideEnd })
            continue
          }
        }
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChildren[i]
      if (child) stack.push(child)
    }
  }
  if (raw.length === 0) return []
  raw.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine)
  const merged: ElidedSpan[] = []
  for (const span of raw) {
    const last = merged[merged.length - 1]
    if (last && span.startLine <= last.endLine + 1) {
      if (span.endLine > last.endLine) last.endLine = span.endLine
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

function formatLineRow(lineText: string, lineNumber: number, anchored: boolean): string {
  const row = anchored
    ? addAnchoredLineNumbers({ content: lineText, startLine: lineNumber })
    : addLineNumbers({ content: lineText, startLine: lineNumber })
  const match = /^(\d+(?:#[0-9a-f]+)?\t)([\s\S]*)$/.exec(row)
  if (!match || match[2]!.length <= 2000) return row
  const text = match[2]!
  return `${match[1]}${text.slice(0, 2000)}… [truncated ${text.length - 2000} characters]`
}

export async function buildOutlineNumberedWindow(
  filePath: string,
  content: string,
  startLine: number,
  numLines: number,
  totalLines: number,
  anchored: boolean,
): Promise<string | null> {
  if (content === '' || numLines <= 0) return null
  if (totalLines > OUTLINE_MAX_LINES || Buffer.byteLength(content, 'utf8') > OUTLINE_MAX_BYTES) {
    return null
  }
  const lang = languageForFile(filePath)
  if (!lang) return null
  const cacheKey = `${lang.name}:${startLine}:${numLines}:${anchored ? 1 : 0}:${runtimeKernel().hash.sha256Hex(content).slice(0, 16)}`
  const cached = outlineCache.get(cacheKey)
  if (cached !== undefined) return rememberOutline(cacheKey, cached)

  const engine = await loadGrammarEngine()
  if (engine.state === 'unavailable') return null
  const parsed = await parsePolyglot(engine, lang, content)
  if ('state' in parsed) return null
  let spans: ElidedSpan[]
  try {
    spans = collectElidedSpans(parsed.tree.rootNode, lang.name)
  } finally {
    parsed.tree.delete()
  }

  const lines = content.split('\n')
  if (content.endsWith('\n') && lines.length === numLines + 1) lines.pop()
  if (spans.length === 0) {
    const plain = lines.map((line, idx) => formatLineRow(line, startLine + idx, anchored)).join('\n')
    return rememberOutline(cacheKey, plain)
  }

  const out: string[] = []
  let spanIdx = 0
  let i = 0
  while (i < lines.length) {
    const relLine = i + 1
    while (spanIdx < spans.length && spans[spanIdx]!.endLine < relLine) spanIdx++
    const active = spanIdx < spans.length ? spans[spanIdx]! : undefined
    if (active && relLine === active.startLine) {
      const absStart = startLine + active.startLine - 1
      const absEnd = startLine + active.endLine - 1
      const prevLine = i > 0 ? lines[i - 1]! : lines[i]!
      const indentMatch = /^([ \t]*)/.exec(prevLine)
      const indent = `${indentMatch ? indentMatch[1]! : ''}  `
      const label =
        absStart === absEnd
          ? `… [elided body line ${absStart}]`
          : `… [elided body lines ${absStart}-${absEnd}]`
      out.push(`${absStart}\t${indent}${label}`)
      i = active.endLine
      spanIdx++
      continue
    }
    out.push(formatLineRow(lines[i]!, startLine + i, anchored))
    i++
  }
  return rememberOutline(cacheKey, out.join('\n'))
}
