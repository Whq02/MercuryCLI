import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { commentRanges as hookCommentRanges } from './commentBytes.mjs'
import { hashCandidate, hashComments, hashKindOf, PLAIN_EXTENSIONS, PLAIN_NAMES } from './hashComments.ts'

const COMMENT_KEEP_FOLDERS = ['/src/integrations/extensions/bundled/', '/vendor/']
const HASH_KEEP_FOLDERS = ['vendor/', 'native/']
export const KEEP_REASONS: [under: string, reason: string][] = [
  ['vendor/', 'fetched packs, their lock files and licence texts: not written here'],
  ['native/', "the build pins each crate's source digest, so the crates wait for the next native build"],
  ['src/integrations/extensions/bundled/mercury-media/server/', 'a built bundle the project does not write by hand'],
  ['scripts/field-tasks/field-kit/task/', "the practice task: its comment lines are the task's own specification, read by the tester's session"],
]
const SKIP_NAMES = new Set(['node_modules', 'dist', '.git', 'vendor'])
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

type CommentRange = { pos: number; end: number }
type Placed = { path: string; kind: string }
type TreeCensus = { read: Placed[]; excepted: Map<string, Placed[]>; plain: number; unplaced: string[]; walked: number }

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

function walked(path: string): boolean {
  if (!(path.startsWith('src/') || path.startsWith('scripts/')) || !SOURCE_EXTENSIONS.has(extname(path))) return false
  if (path.split('/').slice(0, -1).some(part => SKIP_NAMES.has(part))) return false
  return !COMMENT_KEEP_FOLDERS.some(folder => `/${path}`.includes(folder))
}

export function keepFolders(): string[] {
  return [...new Set([...HASH_KEEP_FOLDERS, ...KEEP_REASONS.map(([under]) => under)])]
}

export function censusTree(root: string): TreeCensus {
  const folders = keepFolders()
  const census: TreeCensus = { read: [], excepted: new Map(folders.map(folder => [folder, []])), plain: 0, unplaced: [], walked: 0 }
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0')
  for (const path of tracked) {
    if (path === '' || !existsSync(join(root, path))) continue
    if (walked(path)) {
      census.walked++
      continue
    }
    const name = path.slice(path.lastIndexOf('/') + 1)
    const dot = name.lastIndexOf('.')
    const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : null
    if (!hashCandidate(path)) {
      if (PLAIN_NAMES.includes(name) || (extension !== null && PLAIN_EXTENSIONS.includes(extension))) census.plain++
      else census.unplaced.push(path)
      continue
    }
    const kind = hashKindOf(path, extension === null ? readFileSync(join(root, path), 'utf8') : '')
    if (kind === null) {
      census.plain++
      continue
    }
    const folder = folders.find(under => path.startsWith(under))
    if (folder === undefined) census.read.push({ path, kind })
    else census.excepted.get(folder)!.push({ path, kind })
  }
  return census
}

export function commentRanges(path: string, text: string): CommentRange[] {
  if (hashKindOf(path, text) !== null) return hashComments(path, text).filter(comment => comment.keep === null).map(comment => ({ pos: comment.pos, end: comment.end }))
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
