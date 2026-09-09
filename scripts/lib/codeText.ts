import ts from 'typescript'

export type CommentRange = { pos: number; end: number }

export const CODE_TEXT_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/

function scriptKind(path: string): ts.ScriptKind {
  if (/\.(tsx|jsx)$/.test(path)) return ts.ScriptKind.TSX
  if (/\.(m|c)?js$/.test(path)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

export function commentRanges(path: string, text: string): CommentRange[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path))
  const leaves: ts.Node[] = []
  const collect = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JSDoc) return
    const kids = node.getChildren(source)
    if (kids.length === 0) {
      leaves.push(node)
      return
    }
    for (const kid of kids) collect(kid)
  }
  collect(source)
  const isJsxText = (node: ts.Node): boolean =>
    node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces
  const ranges = new Map<number, CommentRange>()
  const add = (list: ts.CommentRange[] | undefined): void => {
    if (!list) return
    for (const range of list) ranges.set(range.pos, { pos: range.pos, end: range.end })
  }
  for (let i = 0; i < leaves.length; i++) {
    const token = leaves[i]!
    if (isJsxText(token)) continue
    add(ts.getLeadingCommentRanges(text, token.getFullStart()))
    const next = leaves[i + 1]
    if (!(next && isJsxText(next))) add(ts.getTrailingCommentRanges(text, token.getEnd()))
  }
  return [...ranges.values()].sort((a, b) => a.pos - b.pos)
}

const WORD = /[A-Za-z0-9_$\u00A0-\uFFFF]/
const JOINABLE = /[+\-*/<>=&|?.]/

function separates(before: string, after: string): boolean {
  if (before === '' || after === '') return false
  if (WORD.test(before) && WORD.test(after)) return true
  if (/[0-9]/.test(before) && after === '.') return true
  return JOINABLE.test(before) && JOINABLE.test(after)
}

export function codeOnlyText(path: string, text: string): string {
  let out = ''
  let cursor = 0
  for (const range of commentRanges(path, text)) {
    if (range.pos < cursor) continue
    out += text.slice(cursor, range.pos)
    const blank = text.slice(range.pos, range.end).replace(/[^\n]/g, '')
    out += blank === '' && separates(out.charAt(out.length - 1), text.charAt(range.end)) ? ' ' : blank
    cursor = range.end
  }
  return out + text.slice(cursor)
}

export function codeOnlyLines(path: string, text: string): string[] {
  return codeOnlyText(path, text).split('\n')
}

export function syntaxShape(path: string, text: string): string {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path))
  const parts: string[] = [String(source.parseDiagnostics.length)]
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JSDoc) return
    const kids = node.getChildren(source)
    if (kids.length === 0) {
      parts.push(`${node.kind}:${text.slice(node.getStart(source), node.end)}`)
      return
    }
    parts.push(String(node.kind))
    for (const kid of kids) visit(kid)
  }
  visit(source)
  return parts.join('\n')
}
