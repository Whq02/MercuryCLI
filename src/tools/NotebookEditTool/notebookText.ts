import type { NotebookCell, NotebookContent } from '../../types/notebook.js'
import { jsonParse, jsonStringify } from '../../utils/slowOperations.js'

type Span = { start: number; end: number; items?: Span[]; props?: Map<string, { key: Span; value: Span }> }

export type NotebookEditPlan = { mode: 'replace' | 'insert' | 'delete'; index: number }

const WS = new Set([' ', '\t', '\n', '\r'])

export function sourceInCellShape(text: string, shape: string | string[] | undefined): string | string[] {
  if (!Array.isArray(shape)) return text
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function skipWs(text: string, i: number): number {
  while (i < text.length && WS.has(text[i] as string)) i++
  return i
}

function spanAt(text: string, start: number): Span {
  if (start >= text.length) throw new Error('unterminated JSON')
  const c = text[start]
  if (c === '{') {
    const props = new Map<string, { key: Span; value: Span }>()
    let i = skipWs(text, start + 1)
    while (text[i] !== '}') {
      const key = spanAt(text, i)
      const value = spanAt(text, skipWs(text, skipWs(text, key.end) + 1))
      props.set(jsonParse(text.slice(key.start, key.end)) as string, { key, value })
      i = skipWs(text, value.end)
      if (text[i] === ',') i = skipWs(text, i + 1)
      if (i >= text.length) throw new Error('unterminated object')
    }
    return { start, end: i + 1, props }
  }
  if (c === '[') {
    const items: Span[] = []
    let i = skipWs(text, start + 1)
    while (text[i] !== ']') {
      const item = spanAt(text, i)
      items.push(item)
      i = skipWs(text, item.end)
      if (text[i] === ',') i = skipWs(text, i + 1)
      if (i >= text.length) throw new Error('unterminated array')
    }
    return { start, end: i + 1, items }
  }
  if (c === '"') {
    let i = start + 1
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    return { start, end: i + 1 }
  }
  let i = start
  while (i < text.length && !WS.has(text[i] as string) && text[i] !== ',' && text[i] !== '}' && text[i] !== ']') i++
  if (i === start) throw new Error('empty JSON value')
  return { start, end: i }
}

function indentBefore(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  const ws = text.slice(lineStart, at)
  return /^[ \t]*$/.test(ws) ? ws : ''
}

function firstKeyOf(span: Span): Span | undefined {
  return span.props?.values().next().value?.key
}

function keyValueSpace(text: string, span: Span): boolean {
  const key = firstKeyOf(span)
  return key !== undefined && text[key.end] === ':' && text[key.end + 1] === ' '
}

function compact(value: unknown, kv: string, sep: string): string {
  if (Array.isArray(value)) return `[${value.map(v => compact(v, kv, sep)).join(sep)}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.map(([k, v]) => `${jsonStringify(k)}${kv}${compact(v, kv, sep)}`).join(sep)}}`
  }
  return jsonStringify(value)
}

function listText(lines: string[], text: string, span: Span, spaced: boolean): string {
  if (lines.length === 0) return '[]'
  const items = span.items ?? []
  if (text.slice(span.start, span.end).includes('\n')) {
    const closeIndent = indentBefore(text, span.end - 1)
    const itemIndent = items[0] !== undefined ? indentBefore(text, items[0].start) : `${closeIndent} `
    return `[\n${lines.map(line => itemIndent + jsonStringify(line)).join(',\n')}\n${closeIndent}]`
  }
  const sep = items.length >= 2 ? text.slice((items[0] as Span).end, (items[1] as Span).start) : spaced ? ', ' : ','
  return `[${lines.map(line => jsonStringify(line)).join(sep)}]`
}

function cellsOf(root: Span): Span[] | null {
  const items = root.props?.get('cells')?.value.items
  return items ?? null
}

function spliceReplace(text: string, root: Span, index: number, cell: NotebookCell): string | null {
  const span = cellsOf(root)?.[index]
  if (span?.props === undefined) return null
  const spaced = keyValueSpace(text, span)
  const want: Record<string, unknown> = { source: cell.source, cell_type: cell.cell_type }
  if (cell.cell_type === 'code') {
    want.execution_count = cell.execution_count
    want.outputs = cell.outputs
  }
  const edits: Array<{ start: number; end: number; text: string }> = []
  for (const [key, value] of Object.entries(want)) {
    const prop = span.props.get(key)
    if (prop === undefined) return null
    if (jsonStringify(jsonParse(text.slice(prop.value.start, prop.value.end))) === jsonStringify(value)) continue
    const next = key === 'source' && Array.isArray(value) ? listText(value, text, prop.value, spaced) : jsonStringify(value)
    edits.push({ start: prop.value.start, end: prop.value.end, text: next })
  }
  let out = text
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

function spliceInsert(text: string, root: Span, index: number, cell: NotebookCell): string | null {
  const items = cellsOf(root)
  if (items === null || items.length === 0 || index > items.length) return null
  const sibling = items[Math.max(0, index - 1)] as Span
  const siblingText = text.slice(sibling.start, sibling.end)
  const elementIndent = indentBefore(text, sibling.start)
  const spaced = keyValueSpace(text, sibling)
  let serialized: string
  if (siblingText.includes('\n')) {
    const key = firstKeyOf(sibling)
    const propIndent = key !== undefined ? indentBefore(text, key.start) : `${elementIndent} `
    const unit = propIndent.startsWith(elementIndent) && propIndent.length > elementIndent.length ? propIndent.slice(elementIndent.length) : ' '
    serialized = jsonStringify(cell, null, unit).split('\n').map((line, k) => (k === 0 ? line : elementIndent + line)).join('\n')
  } else {
    serialized = compact(cell, spaced ? ': ' : ':', spaced ? ', ' : ',')
  }
  const glue = items.length >= 2 ? text.slice((items[0] as Span).end, (items[1] as Span).start) : siblingText.includes('\n') || elementIndent !== '' ? `,\n${elementIndent}` : spaced ? ', ' : ','
  if (index === 0) return text.slice(0, sibling.start) + serialized + glue + text.slice(sibling.start)
  return text.slice(0, sibling.end) + glue + serialized + text.slice(sibling.end)
}

function spliceDelete(text: string, root: Span, index: number): string | null {
  const items = cellsOf(root)
  const array = root.props?.get('cells')?.value
  if (items === null || array === undefined || index >= items.length) return null
  if (items.length === 1) return text.slice(0, array.start + 1) + text.slice(array.end - 1)
  if (index === 0) return text.slice(0, (items[0] as Span).start) + text.slice((items[1] as Span).start)
  return text.slice(0, (items[index - 1] as Span).end) + text.slice((items[index] as Span).end)
}

function spliced(original: string, notebook: NotebookContent, plan: NotebookEditPlan): string | null {
  try {
    const root = spanAt(original, skipWs(original, 0))
    if (root.props === undefined) return null
    const cell = notebook.cells[plan.index]
    if (plan.mode === 'delete') return spliceDelete(original, root, plan.index)
    if (cell === undefined) return null
    return plan.mode === 'replace' ? spliceReplace(original, root, plan.index, cell) : spliceInsert(original, root, plan.index, cell)
  } catch {
    return null
  }
}

function wholeText(notebook: NotebookContent, original: string): string {
  const head = /^\uFEFF?\s*\{(\n[ \t]*)?/.exec(original)
  let space: string | number | undefined = 1
  if (head !== null) {
    const indentLine = head[1]
    if (indentLine === undefined) space = undefined
    else {
      const ws = indentLine.slice(1)
      space = ws === '' ? 1 : ws.includes('\t') ? '\t' : Math.min(ws.length, 10)
    }
  }
  const body = jsonStringify(notebook, null, space)
  return original.endsWith('\n') ? `${body}\n` : body
}

export function notebookTextAfterEdit(original: string, notebook: NotebookContent, plan: NotebookEditPlan): string {
  const candidate = spliced(original, notebook, plan)
  if (candidate !== null && parsesTo(candidate, notebook)) return candidate
  return wholeText(notebook, original)
}

function parsesTo(text: string, notebook: NotebookContent): boolean {
  try {
    return jsonStringify(jsonParse(text)) === jsonStringify(notebook)
  } catch {
    return false
  }
}
