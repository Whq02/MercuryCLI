import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { commentRanges as hookCommentRanges } from './commentBytes.mjs'

const COMMENT_KEEP_FOLDERS = ['/src/extensions/bundled/', '/vendor/']
const SKIP_NAMES = new Set(['node_modules', 'dist', '.git', 'vendor'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

type CommentRange = { pos: number; end: number }

function* sourceFiles(dir: string): Generator<string> {
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
  return (hookCommentRanges(path, text) as CommentRange[]).map(range => ({ pos: range.pos, end: range.end })).sort((a, b) => a.pos - b.pos)
}

export function withoutComments(path: string, text: string): { out: string; removed: number } {
  const ranges = commentRanges(path, text)
  if (ranges.length === 0) return { out: text, removed: 0 }
  let out = ''
  let cursor = 0
  for (const range of ranges) {
    if (range.pos < cursor) continue
    const lineStart = text.lastIndexOf('\n', range.pos - 1) + 1
    let lineEnd = text.indexOf('\n', range.end)
    if (lineEnd === -1) lineEnd = text.length
    const before = text.slice(Math.max(lineStart, cursor), range.pos)
    const after = text.slice(range.end, lineEnd)
    if (before.trim() === '' && after.trim() === '' && lineStart >= cursor) {
      out += text.slice(cursor, lineStart)
      cursor = lineEnd < text.length ? lineEnd + 1 : lineEnd
      continue
    }
    if (after.trim() === '') {
      out += text.slice(cursor, range.pos).replace(/[ \t]+$/, '')
      cursor = range.end
      continue
    }
    out += text.slice(cursor, range.pos)
    cursor = range.end
  }
  out += text.slice(cursor)
  return { out, removed: ranges.length }
}
