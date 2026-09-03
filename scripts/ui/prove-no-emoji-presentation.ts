#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-no-emoji-presentation.ts
//  PROOF (a ratchet): nothing Mercury paints carries an emoji presentation.
//
//  The mechanism: Windows Terminal (and any host whose font fallback prefers
//  its colour font) draws every code point with Unicode's Emoji property as a
//  colour pictograph — the text-default ones (U+26A0, U+2733, U+2714 …) as
//  readily as the emoji-default ones — and the text-presentation selector
//  (U+FE0E) does not reliably talk it out of it. macOS draws the text-default
//  ones as text, so a Mac never shows the defect: the thinking row's asterisk
//  read as a green pictograph on Windows for weeks while every Mac fixture
//  stayed green. The vocabulary law that follows: Mercury paints NO code
//  point with the Emoji property, and a text-default one that must stay is
//  written with U+FE0E behind it (the kit's width model measures the pair as
//  one cell and never splits it).
//
//  Three censuses over src/**/*.ts(x) and the boot-face core
//  (assets/splash/*.mjs), the emoji table vendored at ./lib/emojiProperties.ts
//  (generated from Unicode emoji-data.txt; never a network read here):
//    §1 ANYWHERE — comments included — zero Emoji_Presentation=Yes code
//       points and zero U+FE0F (the emoji-presentation selector).
//    §2 PAINTED — every string literal, template chunk and JSX text (the
//       cooked values, so an escape cannot hide a glyph) plus every symbol
//       reached through the `figures` package — no Emoji=Yes code point
//       stands bare: it is followed by U+FE0E, or it is one of the named
//       base-font exemptions (the ASCII keycap bases and the Latin-1 /
//       letterlike marks every terminal font carries in its own cmap).
//    §3 THE KIT — no GLYPH / SPARK token and not the thinking glyph carries
//       the property at all (the vocabulary never leans on the selector).
//  §4 pins the width law for a selector-carrying pair: one cell, never split
//  by end/start/middle truncation or a hard wrap. §5 is the self-test: a
//  planted bare glyph, a planted pictograph, a planted U+FE0F, a planted
//  escape and a planted `figures.tick` are each caught; the compliant forms
//  are not.
//
//  Width and selector pins differ between bun's native width path and node's
//  JS path, so under bun this proof ALSO bundles itself for node (the search
//  suite's bundle-for-node) and runs that verdict; the bundle's own run skips
//  the re-spawn. Run: ~/.bun/bin/bun scripts/ui/prove-no-emoji-presentation.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { mainSymbols } from 'figures'
import {
  EMOJI_DATA_UNICODE_VERSION,
  EMOJI_PRESENTATION_SELECTOR,
  TEXT_PRESENTATION_SELECTOR,
  hasEmojiPresentation,
  hasEmojiProperty,
} from './lib/emojiProperties.ts'
import { GLYPH, SPARK, displayWidth, padTo } from '../../src/components/mercury-ui/glyphs.js'
import { stringWidth } from '../../src/ink/stringWidth.js'
import wrapText from '../../src/ink/wrap-text.js'
import { truncatePathMiddle, truncateStartToWidth, truncateToWidth } from '../../src/utils/truncate.js'
import { THINKING_GLYPH, THINKING_LABEL } from '../../src/components/messages/thinkingGrammar.js'

// import.meta.url, not import.meta.dir: only Bun defines .dir, and the node
// arm runs this file as a bundle written OUTSIDE the tree (the OS temp dir),
// where `../..` reaches nothing — the working directory is then the root.
const HERE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = existsSync(join(HERE_ROOT, 'src', 'components')) ? HERE_ROOT : process.cwd()
const RUNTIME = process.versions.bun ? 'bun' : 'node'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const VS15 = String.fromCharCode(TEXT_PRESENTATION_SELECTOR)
const VS16 = String.fromCharCode(EMOJI_PRESENTATION_SELECTOR)
const cpName = (cp: number): string => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0')

// ── the census engine ────────────────────────────────────────────────────────

/** Code points the data file lists as Emoji=Yes that no terminal ever routes
 *  to a colour font: the ASCII keycap bases (only an emoji inside a keycap
 *  SEQUENCE) and the Latin-1 / letterlike marks every monospace font carries
 *  in its own cmap, so no fallback is reached. Widen only from field evidence. */
const BASE_FONT_TEXT = new Set<number>([
  0x23, 0x2a, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, // # * 0-9
  0xa9, // ©
  0xae, // ®
  0x2122, // ™
])

type Rule = 'emoji-presentation' | 'emoji-selector' | 'bare-emoji-property'
type Finding = { file: string; line: number; col: number; codePoint: number; rule: Rule; via: string }

/** §2's per-string law over an already-cooked painted value. */
function paintedFindings(text: string, at: (offset: number) => { line: number; col: number }, file: string, via: string): Finding[] {
  const out: Finding[] = []
  const cps = Array.from(text)
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!.codePointAt(0)!
    const pos = at(i)
    if (cp === EMOJI_PRESENTATION_SELECTOR) out.push({ file, ...pos, codePoint: cp, rule: 'emoji-selector', via })
    else if (hasEmojiPresentation(cp)) out.push({ file, ...pos, codePoint: cp, rule: 'emoji-presentation', via })
    else if (hasEmojiProperty(cp) && !BASE_FONT_TEXT.has(cp)) {
      const next = cps[i + 1]?.codePointAt(0)
      if (next !== TEXT_PRESENTATION_SELECTOR) out.push({ file, ...pos, codePoint: cp, rule: 'bare-emoji-property', via })
    }
  }
  return out
}

/** §1's law over the raw file text, comments included. */
function anywhereFindings(text: string, file: string): Finding[] {
  const out: Finding[] = []
  let line = 1
  let col = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x0a) {
      line++
      col = 0
      continue
    }
    col++
    if (hasEmojiPresentation(cp)) out.push({ file, line, col, codePoint: cp, rule: 'emoji-presentation', via: 'anywhere' })
    else if (cp === EMOJI_PRESENTATION_SELECTOR) out.push({ file, line, col, codePoint: cp, rule: 'emoji-selector', via: 'anywhere' })
  }
  return out
}

function scriptKindOf(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.mjs') || file.endsWith('.js') || file.endsWith('.cjs')) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

/** A painted-value candidate: any file carrying a non-ASCII Emoji=Yes code
 *  point, a backslash-u escape (the cooked value may be one), or a `figures`
 *  reference the parser must resolve. */
function worthParsing(text: string): boolean {
  if (text.includes('figures') || /\\u(?:[0-9a-fA-F]{4}|\{)/.test(text)) return true
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp > 0x7f && hasEmojiProperty(cp)) return true
  }
  return false
}

/** §2 over one source text: the parser's string-shaped nodes plus the
 *  symbols reached through the figures package's default import. */
export function paintedFindingsOfSource(file: string, text: string): Finding[] {
  if (!worthParsing(text)) return []
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKindOf(file))
  const findings: Finding[] = []
  let figuresBinding: string | null = null
  const at = (node: ts.Node) => {
    const p = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    return { line: p.line + 1, col: p.character + 1 }
  }
  const stringNode = (node: ts.Node, value: string, via: string): void => {
    const pos = at(node)
    findings.push(...paintedFindings(value, () => pos, file, via))
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === 'figures' && node.importClause?.name) {
        figuresBinding = node.importClause.name.text
      }
      return // a module specifier is a path, never paint
    }
    if (ts.isExportDeclaration(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      stringNode(node, node.text, 'string')
      return
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      stringNode(node, node.text ?? '', 'template')
      return
    }
    if (ts.isJsxText(node)) {
      stringNode(node, node.text, 'jsx-text')
      return
    }
    if (
      figuresBinding !== null &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === figuresBinding &&
      ts.isIdentifier(node.name)
    ) {
      const symbol = (mainSymbols as Record<string, string>)[node.name.text]
      if (typeof symbol === 'string') stringNode(node, symbol, `figures.${node.name.text}`)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return findings
}

function walk(dir: string, exts: string[], out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === '__snapshots__') continue
      walk(p, exts, out)
    } else if (exts.some(ext => p.endsWith(ext))) {
      out.push(p)
    }
  }
}

const describe = (f: Finding): string =>
  `${f.file}:${f.line}:${f.col} ${cpName(f.codePoint)} ${String.fromCodePoint(f.codePoint)} ${f.rule} (${f.via})`

// ── the run ─────────────────────────────────────────────────────────────────

console.log('============================================================')
console.log(` no-emoji-presentation — the paint census (Unicode ${EMOJI_DATA_UNICODE_VERSION}, under ${RUNTIME})`)
console.log('============================================================')

section('§1 ANYWHERE: zero emoji-presentation code points, zero U+FE0F, comments included')
const files: string[] = []
walk(join(ROOT, 'src'), ['.ts', '.tsx'], files)
walk(join(ROOT, 'assets', 'splash'), ['.mjs'], files)
files.sort()
const anywhere: Finding[] = []
const painted: Finding[] = []
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  // Byte-honest: the bytes decode as UTF-8 whatever else the file carries.
  const text = readFileSync(abs).toString('utf8')
  anywhere.push(...anywhereFindings(text, rel))
  painted.push(...paintedFindingsOfSource(rel, text))
}
check(
  `${files.length} files walked (src ts/tsx + the boot-face core)`,
  files.length > 100 && files.some(f => f.endsWith('splash-core.mjs')),
)
check(
  'no Emoji_Presentation=Yes code point and no U+FE0F anywhere',
  anywhere.length === 0,
  anywhere.length ? `\n      - ${anywhere.slice(0, 40).map(describe).join('\n      - ')}` : 'clean',
)

section('§2 PAINTED: every string, template chunk, JSX text and figures symbol')
check(
  'no painted Emoji=Yes code point stands bare (U+FE0E behind it, or a named base-font exemption)',
  painted.length === 0,
  painted.length ? `\n      - ${painted.slice(0, 60).map(describe).join('\n      - ')}` : 'clean',
)

section('§3 THE KIT: the vocabulary never leans on the selector')
const carrying = (label: string, value: string): string | null => {
  for (const ch of value) {
    const cp = ch.codePointAt(0)!
    if (hasEmojiProperty(cp)) return `${label}=${JSON.stringify(value)} (${cpName(cp)})`
  }
  return null
}
const kitHits = [
  ...Object.entries(GLYPH).map(([k, v]) => carrying(`GLYPH.${k}`, v)),
  ...SPARK.map((v, i) => carrying(`SPARK[${i}]`, v)),
].filter((x): x is string => x !== null)
check('no GLYPH / SPARK token carries the Emoji property', kitHits.length === 0, kitHits.join(', ') || `${Object.keys(GLYPH).length + SPARK.length} tokens clean`)
check('the thinking glyph carries no Emoji property (U+273B, the teardrop-spoked asterisk)', THINKING_GLYPH === '\u273B' && carrying('thinking', THINKING_GLYPH) === null)
check('the thinking label measures glyph + space + word + ellipsis, one cell for the glyph', stringWidth(THINKING_GLYPH) === 1 && stringWidth(THINKING_LABEL) === 1 + 1 + 'thinking'.length + 1)
check('the figures symbols Mercury still reaches carry no Emoji property (pointer, arrows, checkboxes, star, circle, bullet, ellipsis, pointerSmall, cross)', ['pointer', 'arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight', 'checkboxOn', 'checkboxOff', 'star', 'circle', 'bullet', 'ellipsis', 'pointerSmall', 'cross'].every(name => carrying(name, (mainSymbols as Record<string, string>)[name]!) === null))
check('and the ones it left DO (tick, warning, info, squareSmall, squareSmallFilled) — the swap was necessary', ['tick', 'warning', 'info', 'squareSmall', 'squareSmallFilled'].every(name => carrying(name, (mainSymbols as Record<string, string>)[name]!) !== null))

section('§4 THE WIDTH LAW: a text-default glyph + U+FE0E is one cell and never splits')
const PAIR = '\u25B2' + VS15 // ▲︎ — the kit's warn lead behind the selector
const intact = (s: string): boolean => {
  // every selector in the output sits right behind its base
  const cps = Array.from(s)
  return cps.every((c, i) => c !== VS15 || cps[i - 1] === '\u25B2')
}
check('stringWidth(pair) === 1 (the selector is zero-width)', stringWidth(PAIR) === 1, `w=${stringWidth(PAIR)}`)
check('displayWidth("pair warn") === 6', displayWidth(`${PAIR} warn`) === 6)
check('padTo(pair, 3) fills to exactly 3 cells', displayWidth(padTo(PAIR, 3)) === 3 && padTo(PAIR, 3) === `${PAIR}  `)
{
  const end = truncateToWidth(`${PAIR} warning`, 3)
  check('end truncation keeps the pair whole', end.includes(PAIR) && intact(end), JSON.stringify(end))
  const start = truncateStartToWidth(`warning ${PAIR}`, 3)
  check('start truncation keeps the pair whole', start.includes(PAIR) && intact(start), JSON.stringify(start))
  const mid = truncatePathMiddle(`src/${PAIR}dir/file.ts`, 14)
  check('middle truncation keeps the pair whole', mid.includes(PAIR) && intact(mid), JSON.stringify(mid))
  const dropped = truncatePathMiddle(`src/${PAIR}/file.ts`, 13)
  check('a budget landing ON the pair drops it whole, never the base alone', intact(dropped) && !dropped.includes('\u25B2') === !dropped.includes(VS15), JSON.stringify(dropped))
  for (const mode of ['truncate', 'truncate-start', 'truncate-middle'] as const) {
    const out = wrapText(`aaaa ${PAIR}bbbb ${PAIR}cccc`, 7, mode)
    check(`ink ${mode} never orphans the selector`, intact(out), JSON.stringify(out))
  }
  const wrapped = wrapText(`aaaa${PAIR}bbbb ${PAIR}cc`, 5, 'wrap')
  const lines = wrapped.split('\n')
  check('a hard wrap never separates base and selector', lines.every(intact) && lines.every(l => stringWidth(l) <= 5), JSON.stringify(wrapped))
}

section('§5 SELF-TEST: the census bites on each planted form and stays quiet on the compliant ones')
const plant = (name: string, source: string): Finding[] => paintedFindingsOfSource(name, source)
const rulesOf = (fs: Finding[]): string => fs.map(f => `${f.rule}@${f.via}`).join(',') || 'none'
{
  const bare = plant('t.ts', "const a = '\u26A0 warn'")
  check('a bare text-default glyph in a string is caught', bare.length === 1 && bare[0]!.rule === 'bare-emoji-property', rulesOf(bare))
  const pict = plant('t.ts', "const b = '\u2728 done'")
  check('an emoji-default pictograph in a string is caught', pict.length === 1 && pict[0]!.rule === 'emoji-presentation', rulesOf(pict))
  const vs16 = plant('t.ts', `const b2 = '\u26A0${VS16}'`)
  check('U+FE0F behind a glyph is caught (emoji presentation requested)', vs16.some(f => f.rule === 'emoji-selector'), rulesOf(vs16))
  const okPair = plant('t.ts', `const c = '\u26A0${VS15} fine'`)
  check('the same glyph behind U+FE0E passes', okPair.length === 0, rulesOf(okPair))
  const escaped = plant('t.ts', "const g = '\\u26A0'")
  check('a backslash-u escape cannot hide a painted glyph (the cooked value is scanned)', escaped.length === 1, rulesOf(escaped))
  const tpl = plant('t.ts', 'const e = `${x} \u26A0 tail`')
  check('a template chunk is scanned', tpl.length === 1 && tpl[0]!.via === 'template', rulesOf(tpl))
  const jsx = plant('t.tsx', "const f = <Text>\u26A0 hi</Text>")
  check('JSX text is scanned', jsx.length === 1 && jsx[0]!.via === 'jsx-text', rulesOf(jsx))
  const fig = plant('t.ts', "import figures from 'figures'\nconst d = figures.tick")
  check('figures.tick resolves to its symbol and is caught', fig.length === 1 && fig[0]!.via === 'figures.tick', rulesOf(fig))
  const figOk = plant('t.ts', "import figures from 'figures'\nconst d = figures.pointer + figures.arrowRight")
  check('figures.pointer / figures.arrowRight pass', figOk.length === 0, rulesOf(figOk))
  const comment = plant('t.ts', "// \u26A0 a comment naming the glyph\nconst h = 1")
  check('§2 ignores comments (the §1 anywhere pass owns pictographs there)', comment.length === 0, rulesOf(comment))
  const anywhereHit = anywhereFindings("// \u2728 in a comment\n", 't.ts')
  check('§1 catches a pictograph inside a comment', anywhereHit.length === 1 && anywhereHit[0]!.line === 1, rulesOf(anywhereHit))
  const vocab = plant('t.ts', "const v = '\u273B thinking\u2026 \u2713 \u25B2 \u25CB \u21C4 \u21B3 \u276F \u2192'")
  check('the kit vocabulary (✻ ✓ ▲ ○ ⇄ ↳ ❯ →) passes', vocab.length === 0, rulesOf(vocab))
  const exempt = plant('t.ts', "const i = '\u00A9 2026 #1 * \u00AE \u2122'")
  check('the base-font exemptions pass (© ® ™ and the keycap bases)', exempt.length === 0, rulesOf(exempt))
  const regex = plant('t.ts', 'const r = /[\u26A0]/u')
  check('a regex literal is not a painted string', regex.length === 0, rulesOf(regex))
}

// ── the node arm ────────────────────────────────────────────────────────────
if (RUNTIME === 'bun' && process.env.NO_EMOJI_PRESENTATION_ARM !== 'node') {
  section('§6 THE NODE ARM: the same verdict under node (bun width ≠ node width)')
  const vendored = join(ROOT, 'vendor', 'node', 'extracted', `${process.platform}-${process.arch}`, 'bin', 'node')
  const nodeBin = existsSync(vendored) ? vendored : 'node'
  const dir = mkdtempSync(join(tmpdir(), 'no-emoji-presentation-'))
  const bundle = join(dir, 'prove-no-emoji-presentation.mjs')
  try {
    const built = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'search', 'lib', 'bundle-for-node.ts'), fileURLToPath(import.meta.url), bundle],
      { cwd: ROOT, encoding: 'utf8' },
    )
    check('the node bundle builds', built.status === 0 && existsSync(bundle), (built.stderr || built.stdout).slice(-400))
    if (built.status === 0) {
      const run = spawnSync(nodeBin, [bundle], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, NO_EMOJI_PRESENTATION_ARM: 'node' },
        maxBuffer: 64 * 1024 * 1024,
      })
      const out = (run.stdout ?? '') + (run.stderr ?? '')
      const failedLines = out.split('\n').filter(l => l.includes('[FAIL]'))
      check(
        `node verdict is green (${nodeBin === vendored ? 'vendored node' : 'PATH node'})`,
        run.status === 0 && out.includes('under node') && out.includes('ALL NO-EMOJI-PRESENTATION PROOFS PASS'),
        run.status === 0 ? '' : `status=${run.status}\n      ${failedLines.join('\n      ') || out.slice(-600)}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL NO-EMOJI-PRESENTATION PROOFS PASS')
else console.log(`${failures} NO-EMOJI-PRESENTATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
