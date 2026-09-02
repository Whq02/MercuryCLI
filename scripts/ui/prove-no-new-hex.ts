#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-no-new-hex.ts
//  PROOF (a ratchet): the "Zero new hex outside mercuryPalette/sessionAccent;
//  always import the token" HARD rule (stated by the mercuryPalette.ts header;
//  the wards engine mirrors it at edit time) is locked mechanically here. This
//  guard scans the live src/ tree for QUOTED 6-digit hex color literals
//  ('#RRGGBB' / "#RRGGBB") and fails on any that is NOT the single-source-of-
//  truth pair OR a documented, deliberately-separate palette on the allowlist
//  below. It is a freeze, not a flag-day: the known PRE-EXISTING redeclarations
//  are recorded here so the gate stays green today yet goes RED the instant a
//  NEW literal lands in a live surface — stopping the bleed without forcing an
//  out-of-scope refactor of the existing debt.
//
//  Why "quoted" and not bare `#......`: issue/PR/HackerOne refs in comments
//  (e.g. `#3543050`, `anthropic#287008`, `#304930`) are bare and would false-
//  positive a naive grep; a TUI color is always a quoted string literal.
//  Comment lines are skipped too (belt-and-suspenders for `// #DE4A35 …` notes).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-no-new-hex.ts
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')

// The two files that ARE the source of truth — hex MAY be declared here.
const SOT = new Set<string>([
  'src/components/mercuryPalette.ts',
  'src/components/mercury-ui/sessionAccent.ts',
])

// Whole subtrees that are design SPECIMENS, not live chrome (zero live
// importers — the Ink analog of the design-system/full-* reference cards).
// (pass-3): the src/design/ exemption is DROPPED — the ledger
// flagged it as a blind spot (any hex parked there escaped the floor). No
// exempt dirs remain; a legitimate new hex belongs in mercuryPalette/sessionAccent.
const EXEMPT_DIRS: string[] = []

// Documented, deliberately-separate palettes + known pre-existing debt. Each
// entry names WHY the literal is allowed to live outside the SoT pair. Adding a
// NEW file here is a conscious decision an operator diff-read should see — that
// is the point of the ratchet (don't add lightly; fix the file instead).
const ALLOW: Record<string, string> = {
  // — deliberately-separate palettes (a distinct namespace, not a redeclaration) —
  // agentColorPalette.ts pruned with the tf-port batch.
  'src/utils/cockpit/critterData.ts': 'critter art-data hues (sibling to sessionAccent CRITTERS); EYE_BG annotated == IVORY',
  'src/commands/insights.ts': 'CSS hex inside a generated HTML report string — not a TUI token',
  // heatmap.ts removed from the allowlist when it moved to the
  // imported TERRA token; the file itself was deleted with the stats estate
  // (orphan burn-down), so no row remains.
  // — known PRE-EXISTING TUI redeclarations (frozen debt; convert to mercuryPalette imports when next touched) —
  // MercuryFleetChat / MercuryFullscreen / MercuryModelPicker / MercuryPermissionsPanel
  // all now import the tokens — removed from the allowlist so the
  // guard re-enforces them.
  // MercuryPrBadge / MercuryTeammateTree removed from the allowlist: both
  // now import tokens (PrBadge → CRIMSON/OASIS/TEAL, its '#'+num is a PR number not
  // a hex; TeammateTree → IVORY/TERRA/AMBER/CRITTERS.jellyfish) — the
  // guard re-enforces them.
}

const HEX = /['"]#[0-9a-fA-F]{6}['"]/

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (e === 'node_modules' || e === '__snapshots__') continue
      walk(p, out)
    } else if (p.endsWith('.ts') || p.endsWith('.tsx')) {
      out.push(p)
    }
  }
}

function isComment(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' no-new-hex — palette single-source-of-truth ratchet')
console.log('============================================================')

const files: string[] = []
walk(SRC, files)

section('scan: quoted hex literals outside the SoT pair + allowlist')
const offenders: string[] = []
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  if (SOT.has(rel)) continue
  if (EXEMPT_DIRS.some(d => rel.startsWith(d))) continue
  // Auto-generated bundled-skill content modules INLINE skill markdown +
  // helper-script text (design skills legitimately carry hex color examples,
  // e.g. algorithmic-art / canvas-design / theme-factory). They are skill
  // ASSETS, not Mercury TUI source — never a leaked-hue risk. HEADER-SNIFFED,
  // not path-blanket: only files the codegen stamps are exempt; any
  // hand-written Content module stays scanned.
  if (
    rel.startsWith('src/skills/bundled/') &&
    rel.endsWith('Content.ts') &&
    readFileSync(abs, 'utf8').startsWith('// AUTO-GENERATED by scripts/skills/gen-bundled.ts')
  )
    continue
  if (ALLOW[rel]) continue
  const text = readFileSync(abs, 'utf8')
  let n = 0
  for (const line of text.split('\n')) {
    if (isComment(line)) continue
    if (HEX.test(line)) n++
  }
  if (n > 0) offenders.push(`${rel} (${n} literal${n === 1 ? '' : 's'})`)
}

check('the SoT pair is present (guard is anchored to real files)', SOT.size === 2)
check(
  'no NEW quoted hex literal in a live src file (outside SoT/specimen/allowlist)',
  offenders.length === 0,
  offenders.length ? `offenders:\n      - ${offenders.join('\n      - ')}` : 'clean',
)

section('scan: named chalk colours (UX-6 — the hex ratchet blind spot)')
// chalk.cyan(...)-style NAMED colours bypass both the token system and the
// quoted-hex scan above. FROZEN per-file allowlist of the pre-existing estate
// (CLI/boot-time output where chalk is the medium — main.tsx subcommand help,
// setup, the colorize bridge itself, auth/teleport/worktree CLI strings).
// A NEW named-colour use in any other file fails; shrinking a count is free.
const CHALK_NAMED = /chalk(?:\.\w+)*\.(cyan|magenta|yellow|red|green|blue|white|black|gray|grey|cyanBright|magentaBright|yellowBright|redBright|greenBright|blueBright)\b/
const CHALK_ALLOW: Record<string, number> = {
  'src/main.tsx': 28,
  'src/setup.ts': 9,
  'src/ink/colorize.ts': 15,
  'src/utils/teleport.tsx': 6,
  'src/utils/auth.ts': 6,
  'src/utils/worktree.ts': 1,
  'src/utils/shell/prefix.ts': 1,
  'src/utils/hyperlink.ts': 1,
}
const chalkOffenders: string[] = []
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  let n = 0
  for (const line of readFileSync(abs, 'utf8').split('\n')) {
    if (isComment(line)) continue
    if (CHALK_NAMED.test(line)) n++
  }
  const budget = CHALK_ALLOW[rel] ?? 0
  if (n > budget) chalkOffenders.push(`${rel} (${n} > frozen ${budget})`)
}
check(
  'no NEW named chalk colour outside the frozen allowlist',
  chalkOffenders.length === 0,
  chalkOffenders.length ? `offenders:\n      - ${chalkOffenders.join('\n      - ')}` : 'clean',
)

section('self-test: the matcher catches a quoted literal but not an issue ref')
check("matches a quoted color literal '#DE4A35'", HEX.test("color = '#DE4A35'"))
check('matches a double-quoted literal "#1B1916"', HEX.test('bg = "#1B1916"'))
check('does NOT match a bare issue ref #3543050', !HEX.test('// HackerOne #3543050'))
check('does NOT match anthropic#287008', !HEX.test('// anthropics/anthropic#287008'))
check('comment lines are skipped', isComment('  // const TERRA = \'#DE4A35\''))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL NO-NEW-HEX PROOFS PASS')
else console.log(`❌ ${failures} NO-NEW-HEX PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
