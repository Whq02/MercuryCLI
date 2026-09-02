#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-ordering-pin-teeth.ts
// THE VACUOUS-ORDERING-PIN RATCHET (the split-view
//  find).
//
//  A source-census pin of the shape `hay.indexOf(A) < hay.indexOf(B)` goes
//  TRIVIALLY GREEN when the needle on the SMALLER side rots: indexOf answers
//  -1, and -1 is below every present index (for `>` it is the RIGHT needle
//  that rots the same way). prove-cross-project's settle-after-enter pin did
//  exactly that the moment the enter call gained an argument — a green pin
//  over a red fact, the never-unlink lesson's family.
//
//  The sweep re-toothed every direct compare under scripts/ with a presence
//  assert on the needle that can rot silently. This ratchet keeps the class
//  closed: every direct compare (one line or wrapped) must have its
//  vulnerable needle PROVEN PRESENT in its own statement — an explicit
//  `!== -1` / `>= 0` / `> -1` / `> 0` guard, an `includes(needle)`, or a
//  chained compare that already proves it (a < b proves b once a is proven;
//  a > b proves a once b is). A bare instance anywhere reads RED here with
//  its file:line. The scanner is unit-poisoned below before the tree walk.
//
//  Run:  ~/.bun/bin/bun run scripts/consistency-census/prove-ordering-pin-teeth.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')
const SCRIPTS = join(ROOT, 'scripts')

/** Fixture repos embed foreign source as strings — never pins. */
const EXEMPT_DIRS = ['scripts/mission-runner/corpus/']
/** Judged sites (path → the reason it is not a vacuous pin). */
const EXEMPT_FILES: Record<string, string> = {
  'scripts/autopilot/prove-plan-doctrine.ts': 'the compare is a QUOTED needle inside includes(…) — the product source line is what is pinned',
  'scripts/formal-models/prove-flag-interactions.ts': '`cluster.indexOf(b) <= cluster.indexOf(a)` is loop control over a known membership, not a pin',
}

const NEEDLE = String.raw`(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\`(?:[^\`\\]|\\.)*\`|[A-Za-z_$][\w$.]*)`
const OBJ = String.raw`[A-Za-z_$][\w$.\[\]?!]*`
const COMPARE = new RegExp(String.raw`(${OBJ})\.indexOf\((${NEEDLE})\)\s*(<=?|>=?)\s*(${OBJ})\.indexOf\((${NEEDLE})\)`, 'g')

export interface BareCompare {
  line: number
  text: string
  vulnerable: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every direct compare whose rot-able needle is not proven present within
 *  its statement window (the compare's own lines + the 8 lines above). */
export function bareOrderingCompares(source: string): BareCompare[] {
  const out: BareCompare[] = []
  const re = new RegExp(COMPARE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const [whole, x, a, op, y, b] = m as unknown as [string, string, string, string, string, string]
    const start = m.index
    const end = start + whole.length
    // The window: from 8 lines above the compare's first line to the end of
    // its last line.
    let lo = start
    for (let n = 0; n < 9 && lo > 0; n++) {
      lo = source.lastIndexOf('\n', lo - 1)
      if (lo === -1) {
        lo = 0
        break
      }
    }
    const hi = source.indexOf('\n', end)
    const window = source.slice(lo, hi === -1 ? source.length : hi)
    const left = `${x}.indexOf(${a})`
    const right = `${y}.indexOf(${b})`
    const vulnerable = op.startsWith('<') ? left : right
    // Explicit proofs of presence anywhere in the window.
    const proven = new Set<string>()
    const exprs = new Set<string>()
    const wre = new RegExp(COMPARE.source, 'g')
    let w: RegExpExecArray | null
    const chain: Array<{ l: string; r: string; op: string }> = []
    while ((w = wre.exec(window)) !== null) {
      const [, wx, wa, wop, wy, wb] = w as unknown as [string, string, string, string, string, string]
      const l = `${wx}.indexOf(${wa})`
      const r = `${wy}.indexOf(${wb})`
      exprs.add(l)
      exprs.add(r)
      chain.push({ l, r, op: wop })
    }
    exprs.add(vulnerable)
    for (const e of exprs) {
      // `=== 0` is a POSITION pin that doubles as presence: a vanished needle
      // reads -1 there, so the check that carries it fails loudly on rot.
      const guard = new RegExp(`${escapeRe(e)}\\s*(?:!==\\s*-1|>=\\s*0|>\\s*-1|>\\s*0|===\\s*0)`)
      const inc = e.match(/^(.*)\.indexOf\((.*)\)$/)
      const includes = inc !== null ? new RegExp(`${escapeRe(inc[1]!)}\\.includes\\(${escapeRe(inc[2]!)}\\)`) : null
      if (guard.test(window) || (includes !== null && includes.test(window))) proven.add(e)
    }
    // Transitive proof through the chain (a < b proves b once a is proven;
    // a > b proves a once b is), to a fixpoint.
    let grew = true
    while (grew) {
      grew = false
      for (const c of chain) {
        if (c.op.startsWith('<') && proven.has(c.l) && !proven.has(c.r)) {
          proven.add(c.r)
          grew = true
        }
        if (c.op.startsWith('>') && proven.has(c.r) && !proven.has(c.l)) {
          proven.add(c.l)
          grew = true
        }
      }
    }
    if (!proven.has(vulnerable)) {
      const line = source.slice(0, start).split('\n').length
      out.push({ line, text: whole.replace(/\s*\n\s*/g, ' '), vulnerable })
    }
  }
  return out
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(p)
  }
}

console.log('============================================================')
console.log(' Ordering-pin teeth — no indexOf compare can go green on a rotted needle')
console.log('============================================================')

// ── §1 the scanner, poisoned ────────────────────────────────────────────────
console.log('§1 the scanner (unit-poisoned before the tree walk)')
{
  const bare = "check('a before b', s.indexOf('a') < s.indexOf('b'))"
  check('a bare `<` compare is flagged with its rot-able LEFT needle', bareOrderingCompares(bare).length === 1 && bareOrderingCompares(bare)[0]?.vulnerable === "s.indexOf('a')")
  const bareGt = "check('a after b', s.indexOf('a') > s.indexOf('b'))"
  check('a bare `>` compare is flagged with its rot-able RIGHT needle', bareOrderingCompares(bareGt).length === 1 && bareOrderingCompares(bareGt)[0]?.vulnerable === "s.indexOf('b')")
  check('the presence assert on the rot-able needle clears it', bareOrderingCompares("check('x', s.indexOf('a') !== -1 && s.indexOf('a') < s.indexOf('b'))").length === 0)
  check('a `> 0` / `>= 0` / `> -1` anchor clears it too', ['> 0', '>= 0', '> -1'].every(g => bareOrderingCompares(`check('x', s.indexOf('b') ${g} && s.indexOf('a') > s.indexOf('b'))`).length === 0))
  check('an `=== 0` position pin clears it (rot reads -1 there and fails the check itself)', bareOrderingCompares("check('x', s.indexOf('a') === 0 && s.indexOf('a') < s.indexOf('b'))").length === 0)
  check('POISON: a guard on the WRONG side (the needle that cannot rot silently) does not clear a `>` compare', bareOrderingCompares("check('x', s.indexOf('a') !== -1 && s.indexOf('a') > s.indexOf('b'))").length === 1)
  check('`includes(needle)` on the same haystack proves presence', bareOrderingCompares("check('x', s.includes('a') && s.indexOf('a') < s.indexOf('b'))").length === 0)
  check('a chain proves transitively (a proven ⇒ b ⇒ c)', bareOrderingCompares("check('x', s.indexOf('a') !== -1 && s.indexOf('a') < s.indexOf('b') && s.indexOf('b') < s.indexOf('c'))").length === 0)
  check('a chain with NO anchor is flagged at its first link', bareOrderingCompares("check('x', s.indexOf('a') < s.indexOf('b') && s.indexOf('b') < s.indexOf('c'))").length === 2)
  check('a wrapped (multi-line) bare compare is flagged and reported on its first line', (() => {
    const r = bareOrderingCompares("\n\ncheck(\n  'x',\n  s.indexOf('a') <\n    s.indexOf('b'),\n)")
    return r.length === 1 && r[0]?.line === 5
  })())
  check('the guard may sit on the lines ABOVE the compare (the same statement)', bareOrderingCompares("check(\n  'x',\n  s.indexOf('a') !== -1 &&\n    s.indexOf('a') < s.indexOf('b'),\n)").length === 0)
  check('template-literal and identifier needles are read', bareOrderingCompares('check(\'x\', f.indexOf(`${ESC}[2J`) !== -1 && f.indexOf(`${ESC}[H`) > f.indexOf(`${ESC}[2J`)) && caller.indexOf(FLOOR) !== -1 && caller.indexOf(FLOOR) < caller.indexOf(\'GizmoBot\')').length === 0)
}

// ── §2 the tree ─────────────────────────────────────────────────────────────
console.log('§2 the tree: every direct ordering compare under scripts/ is toothed')
{
  const files: string[] = []
  walk(SCRIPTS, files)
  let compares = 0
  let filesWithCompares = 0
  const violations: string[] = []
  const judged: string[] = []
  for (const file of files.sort()) {
    const rel = relative(ROOT, file).split('\\').join('/')
    if (EXEMPT_DIRS.some(d => rel.startsWith(d))) continue
    if (rel === 'scripts/consistency-census/prove-ordering-pin-teeth.ts') continue
    const source = readFileSync(file, 'utf8')
    const seen = source.match(new RegExp(COMPARE.source, 'g'))?.length ?? 0
    if (seen === 0) continue
    compares += seen
    filesWithCompares++
    if (rel in EXEMPT_FILES) {
      judged.push(`${rel} — ${EXEMPT_FILES[rel]}`)
      continue
    }
    for (const b of bareOrderingCompares(source)) violations.push(`${rel}:${b.line} — ${b.text.slice(0, 140)} (rot-able: ${b.vulnerable.slice(0, 80)})`)
  }
  console.log(`  census: ${compares} direct compares in ${filesWithCompares} files · ${judged.length} judged file(s)`)
  for (const j of judged) console.log(`  judged: ${j}`)
  for (const v of violations) console.log(`  BARE: ${v}`)
  check('the census found the class (the shape is in use — the ratchet is not idle)', compares >= 60, `${compares}`)
  check('ZERO bare ordering compares under scripts/ (a rotted needle can never read green)', violations.length === 0, `${violations.length} bare`)
}

console.log(failures === 0 ? '\nordering-pin teeth: ALL GREEN' : `\nordering-pin teeth: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
