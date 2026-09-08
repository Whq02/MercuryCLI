import { execFileSync } from 'node:child_process'
import ts from 'typescript'

export const TS_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
export const HASH_FILE = /\.(sh|bash|py|yml|yaml|toml|gd|sed|ps1)$/
export const SLASH_FILE = /\.(cs|rs)$/

const KEEP_TS = [
  /^\/\/\/\s*<(reference|amd-)/,
  /^\/\/[#@]\s*source(MappingURL|URL)=/,
  /@ts-(expect-error|ignore|nocheck|check)\b/,
  /\beslint-(disable|enable|env)\b|^\/\*\s*global\b|^\/\/\s*global\b/,
  /prettier-ignore/,
  /@jsx(ImportSource|Frag|Runtime)?\b/,
  /^\/\*!/,
  /@(license|preserve)\b/,
  /[#@]__(PURE|NO_SIDE_EFFECTS)__/,
  /\bgate-(class|watch|env|inputs):/,
  /webpackChunkName/,
  /\b(c8|istanbul|v8)\s+ignore\b/,
  /^\/\/\s*@flow\b/,
]
const JS_JSDOC = /@(type|param|returns?|typedef|template|property|callback|satisfies|import|this)\b/
const KEEP_HASH = /^\s*#\s*(!|-\*-|gate-(class|watch|env|inputs):|shellcheck|type:|noqa|pragma|pylint|fmt:|ruff:|mypy:|flake8:)/
const KEEP_SLASH = /^\s*\/\/\s*(gate-(class|watch|env|inputs):|@ts-|eslint|prettier|#|<reference)/

function keptTs(text, isJs) {
  for (const rx of KEEP_TS) if (rx.test(text)) return true
  return isJs && text.startsWith('/**') && JS_JSDOC.test(text)
}

export function commentRanges(path, text) {
  const isJs = /\.(m|c)?js$/.test(path)
  const kind = /\.(tsx|jsx)$/.test(path) ? ts.ScriptKind.TSX : isJs ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const leaves = []
  const collect = node => {
    const kids = node.getChildren(source)
    if (kids.length === 0) {
      leaves.push(node)
      return
    }
    for (const k of kids) collect(k)
  }
  collect(source)
  const isJsxText = n => n.kind === ts.SyntaxKind.JsxText || n.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces
  const ranges = new Map()
  const add = list => {
    if (list) for (const r of list) ranges.set(r.pos, r)
  }
  for (let i = 0; i < leaves.length; i++) {
    const tok = leaves[i]
    if (isJsxText(tok)) continue
    add(ts.getLeadingCommentRanges(text, tok.getFullStart()))
    const next = leaves[i + 1]
    if (!(next && isJsxText(next))) add(ts.getTrailingCommentRanges(text, tok.getEnd()))
  }
  return [...ranges.values()]
    .sort((a, b) => a.pos - b.pos)
    .filter(r => !keptTs(text.slice(r.pos, r.end), isJs))
}

export function commentBytes(path, text) {
  if (TS_FILE.test(path)) return commentRanges(path, text).reduce((n, r) => n + (r.end - r.pos), 0)
  const lines = text.split('\n')
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trimStart()
    if (HASH_FILE.test(path) && s.startsWith('#') && !(i === 0 && s.startsWith('#!')) && !KEEP_HASH.test(lines[i])) n += lines[i].length
    if (SLASH_FILE.test(path) && s.startsWith('//') && !KEEP_SLASH.test(lines[i])) n += lines[i].length
  }
  return n
}

export function scannedFile(path) {
  return TS_FILE.test(path) || HASH_FILE.test(path) || SLASH_FILE.test(path)
}

export function stagedCommentGrowth(cwd) {
  const git = (...args) => execFileSync('git', args, { cwd, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] })
  const staged = git('diff', '--cached', '--name-only', '--diff-filter=AM', '-z').toString('utf8').split('\0').filter(Boolean)
  const offenders = []
  for (const path of staged) {
    if (!scannedFile(path)) continue
    let now
    try {
      now = git('show', `:${path}`).toString('utf8')
    } catch {
      continue
    }
    let before = ''
    try {
      before = git('show', `HEAD:${path}`).toString('utf8')
    } catch {
      before = ''
    }
    const grew = commentBytes(path, now) - commentBytes(path, before)
    if (grew > 0) offenders.push({ path, bytes: grew })
  }
  return offenders
}

if (process.argv[1] && process.argv[1].endsWith('commentBytes.mjs') && process.argv.includes('--staged')) {
  const offenders = stagedCommentGrowth(process.cwd())
  if (offenders.length > 0) {
    console.error('commit refused: comments are not written; the reasoning goes in the commit message and the receipt. Remove the comment lines added in:')
    for (const o of offenders) console.error(`  ${o.path} (+${o.bytes} bytes of comment)`)
    console.error('Machine lines pass: a shebang, @ts-expect-error, eslint or prettier directives, gate-class and gate-watch header lines.')
    process.exit(1)
  }
}
