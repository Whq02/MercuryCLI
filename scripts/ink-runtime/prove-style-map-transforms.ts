#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-style-map-transforms.ts — styles survive the
//  text transforms (FN-016 R11), under BOTH runtimes.
//
//  THE DEFECT: applyStylesToWrappedText mapped every OUTPUT code unit back
//  to a source segment by walking one index per character — an identity
//  that three transforms break. Truncate-middle/start output is not
//  position-preserving (only the lead is a prefix), so a tool-use header's
//  "+12"/"-3" wore the dim path colour past the ellipsis and a
//  truncate-start line wore the colours of DISCARDED characters. Plain
//  wrap strips each soft-break continuation line's leading space
//  (stripSoftWrapLeadingSpaces) with no compensation — the walk only
//  compensated for wrap-trim — so styles drifted one character early per
//  exactly-at-the-limit break, accumulating line by line. And the bundled
//  wrapper (the product's, under node) normalizes its input to NFC and
//  folds CRLF before it wraps, so a decomposed or CRLF source drifted the
//  map. (The fourth term — the tab — died in R4: tabs expand before the
//  map is built.)
//
//  THE LAW: truncate modes are styled through the cut's OWN boundaries
//  (truncateParts: lead prefix + suffix trail, the ellipsis wearing the
//  first cut character's style) and ONLY the truncate modes — the inert
//  union members `end`/`middle` stay untouched as layout measured them;
//  plain wrap compensates for the stripped continuation indent keyed on
//  the soft-break record (never on whitespace alone — a blank line before
//  an indented one keeps every space); the wrap modes map over the
//  wrapper's own input form so both sides index one string.
//
//  TWO ARMS (the prover-green-under-bun ≠ node law): the laws
//  (styleMapLaws.ts) run in-process under bun, then bundle-and-run under
//  node — the shipped runtime, whose wrap engine is the bundled wrap-ansi
//  (NFC + CRLF + tab expansion) rather than Bun.wrapAnsi. §5 pins the
//  owners structurally.
//
//   §0 the reference dresses (raw truecolor + the theme's inactive);
//   §1 truncate-middle, the header shape, through the REAL pipeline;
//   §2 truncate-start: the visible tail keeps its OWN styles;
//   §3 the wrap face: an exactly-at-the-limit break;
//   §3b the compensation is keyed on soft breaks (blank line + indent);
//   §4 the normalize face (bites under node); §4b its CRLF term;
//   §5 the structured cut is the one owner (wrapText's arm calls it);
//   §6 the inert members `end`/`middle` never cut.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-style-map-transforms.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The colour lane is read at import: force TRUECOLOR before any src module
// evaluates so raw hex dresses emit 38;2;r;g;b specs (a tmux ancestry would
// clamp the depth — the pin is the lane, not the box).
process.env.FORCE_COLOR = '3'
delete process.env.TMUX
const scratchHome = (): string => mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'style-map-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome()

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

// ── arm 1: bun, in-process ──────────────────────────────────────────────────
console.log('prove-style-map-transforms — arm 1: bun (in-process)')
const { runStyleMapLaws } = await import('./styleMapLaws.ts')
failures += await runStyleMapLaws('bun')

// ── arm 2: node, bundle-and-run (the product's runtime) ─────────────────────
section('arm 2: node (bundle-and-run — the shipped wrap engine)')
{
  const cache = join(ROOT, 'node_modules', '.cache', 'mercury-style-map-node')
  mkdirSync(cache, { recursive: true })
  // The version macro the product's modules read is seeded by a module of
  // its own, imported FIRST: an assignment in the entry body would run
  // after the hoisted imports evaluated.
  const macro = join(cache, 'macro.ts')
  writeFileSync(macro, ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\n")
  const entry = join(cache, 'entry.ts')
  const bundle = join(cache, 'style-map-laws.node.mjs')
  writeFileSync(
    entry,
    [
      `import './macro.ts'`,
      `import { runStyleMapLaws } from '${join(ROOT, 'scripts/ink-runtime/styleMapLaws.ts')}'`,
      `process.exit(await runStyleMapLaws('node'))`,
      '',
    ].join('\n'),
  )
  const bunBin = process.env.BUN ?? (existsSync(join(homedir(), '.bun/bin/bun')) ? join(homedir(), '.bun/bin/bun') : 'bun')
  const built = spawnSync(bunBin, [join(ROOT, 'scripts/search/lib/bundle-for-node.ts'), entry, bundle], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    timeout: 180_000,
  })
  check('the laws bundle for node (the search suite\'s bundle-for-node, the product\'s own resolution laws)', built.status === 0, `${built.stdout}${built.stderr}`.slice(-600))
  if (built.status === 0) {
    const nodeBin = process.env.MERCURY_NODE_BIN ?? 'node'
    const version = spawnSync(nodeBin, ['--version'], { encoding: 'utf8', env: process.env }).stdout?.trim() ?? '(unknown)'
    console.log(`  node arm: ${nodeBin} ${version}`)
    const ran = spawnSync(nodeBin, [bundle], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '3', MERCURY_CONFIG_DIR: scratchHome() },
      timeout: 180_000,
    })
    process.stdout.write(ran.stdout ?? '')
    const stderrLines = (ran.stderr ?? '').split('\n').filter(l => l.trim() !== '')
    if (stderrLines.length > 0) process.stdout.write(stderrLines.map(l => `    | ${l}`).join('\n') + '\n')
    check('every law holds under node too (the arm relays its failure count)', ran.status === 0, `status ${ran.status}`)
    check('the node arm actually ran the laws (its log carries the §4 defect pin)', (ran.stdout ?? '').includes('(node) THE DEFECT PIN: the second segment is wholly red past the decomposed cluster'))
  }
}

// ── §5 the structured cut is the one owner ──────────────────────────────────
section('§5 the structured cut is the one owner')
{
  const wrap = readFileSync(join(ROOT, 'src/ink/wrap-text.ts'), 'utf8')
  check('wrapText’s truncate arm rides truncateParts', wrap.includes('const parts = truncateParts(text, maxWidth, wrapType)'))
  check('the owner leaves every non-truncate mode untouched (the inert members never cut)', wrap.includes("if (!wrapType.startsWith('truncate')) return null"))
  const walk = readFileSync(join(ROOT, 'src/ink/compose-walk.ts'), 'utf8')
  check('the compositor styles truncate output through the cut boundaries', walk.includes('styleTruncatedLines(plainText, segments, buildCharToSegmentMap(segments), maxWidth, textWrap)'))
  check('and only for the truncate modes', walk.includes("} else if (needsWrapping && textWrap.startsWith('truncate')) {"))
  check('plain wrap hands the soft-break record to the map (the indent compensation)', walk.includes("textWrap === 'wrap' ? softWrap : undefined,"))
  check('the wrap modes map over the wrapper\'s own input form (one string on both sides)', walk.includes('? wrapperNormalForm(segments, plainText)'))
}

console.log(failures === 0 ? '\nprove-style-map-transforms: ALL LAWS HOLD (bun + node)' : `\nprove-style-map-transforms: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
