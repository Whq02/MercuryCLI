import ts from 'typescript'
import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export const COMMENT_DIRECTIVE = /^\/\/[/ ]*(@ts-|eslint-|biome-|prettier-|<reference\b|#region|#endregion)|^\/\*\s*(eslint|biome|prettier|istanbul|c8|v8|@__PURE__|#__PURE__)/
export const COMMENT_KEEP_FOLDERS = ['/src/extensions/bundled/', '/vendor/']
const SKIP_NAMES = new Set(['node_modules', 'dist', '.git', 'vendor'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

export type CommentRange = { pos: number; end: number }

export function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_NAMES.has(name)) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (SOURCE_EXTENSIONS.has(extname(name))) yield path
  }
}

export function censusFiles(root: string): string[] {
  const out: string[] = []
  for (const sub of ['src', 'scripts']) for (const path of sourceFiles(join(root, sub))) if (!COMMENT_KEEP_FOLDERS.some(folder => path.includes(folder))) out.push(path)
  return out
}

export function commentRanges(path: string, text: string): CommentRange[] {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const ranges: CommentRange[] = []
  const seen = new Set<number>()
  const take = (list: readonly ts.CommentRange[] | undefined, offset = 0): void => {
    for (const range of list ?? []) {
      const pos = offset + range.pos
      const end = offset + range.end
      if (seen.has(pos)) continue
      seen.add(pos)
      if (COMMENT_DIRECTIVE.test(text.slice(pos, end))) continue
      ranges.push({ pos, end })
    }
  }
  const visit = (node: ts.Node): void => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()))
    take(ts.getTrailingCommentRanges(text, node.getEnd()))
    ts.forEachChild(node, visit)
  }
  visit(source)
  take(ts.getLeadingCommentRanges(text, 0))
  const eof = source.endOfFileToken.getFullStart()
  take(ts.getLeadingCommentRanges(text.slice(eof), 0), eof)
  return ranges.sort((a, b) => a.pos - b.pos)
}

export function withoutComments(path: string, text: string): { out: string; removed: number } {
  const ranges = commentRanges(path, text)
  if (ranges.length === 0) return { out: text, removed: 0 }
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    out += text.slice(cursor, range.pos)
    cursor = range.end
  }
  out += text.slice(cursor)
  const kept: string[] = []
  for (const line of out.split('\n').map(line => line.replace(/[ \t]+$/, ''))) {
    if (line === '' && kept.length > 0 && kept[kept.length - 1] === '') continue
    kept.push(line)
  }
  while (kept.length > 1 && kept[0] === '') kept.shift()
  let result = kept.join('\n')
  if (!result.endsWith('\n')) result += '\n'
  return { out: result, removed: ranges.length }
}
