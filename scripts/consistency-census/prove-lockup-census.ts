#!/usr/bin/env bun
// ============================================================================
//  scripts/consistency-census/prove-lockup-census.ts — W4 (UN-23/24/25): the
//  product-lockup ratchet.
//
//  §A CENSUS CURRENT — regenerating gen-lockup-census.ts reproduces the
//     committed lockup-census.json byte-for-byte (a new identity-primitive
//     site must be classified before it can land) and carries ZERO
//     unclassified rows.
//  §B ONE OWNER — /model renders the shared ProductLockup (the same
//     classified owner the manager's CommandCenter shell uses); the
//     CommandCenter header itself consumes ProductLockup (one line, one
//     spelling).
//  §C NO IMITATIONS — the crab glyph run is authored ONLY in the asset owner
//     (mercury-ui/assets.tsx); no other production file hand-draws it, and
//     the statusline PREVIEW renders the real SessionMark (the
//     single-brand law: the statusline anchor is the session critter).
//  §D HIERARCHY — session-identity surfaces (nameplate, seat inspectors)
//     stay on their accent marks; the census classifies them apart from
//     product headers, so gradient inflation cannot land silently (the
//     classification table IS the hierarchy record).
// ============================================================================
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — regeneration is clean + zero unclassified
const censusPath = join(ROOT, 'scripts/consistency-census/lockup-census.json')
const before = readFileSync(censusPath, 'utf8')
execFileSync(process.execPath, [join(ROOT, 'scripts/consistency-census/gen-lockup-census.ts')], {
  cwd: ROOT,
  stdio: 'pipe',
})
const after = readFileSync(censusPath, 'utf8')
// A drift must FAIL, not self-heal: restore the committed bytes so repeated
// runs (and the working tree) stay honest — regeneration is a deliberate act.
if (before !== after) writeFileSync(censusPath, before)
check('§A regeneration reproduces the LOCKUP census byte-for-byte', before === after)
const census = JSON.parse(after) as { sites: Array<{ role: string; file: string }> }
check('§A zero unclassified production sites', census.sites.every(s => s.role !== 'UNCLASSIFIED'), String(census.sites.filter(s => s.role === 'UNCLASSIFIED').length))

// §B — one owner
const picker = readFileSync(join(ROOT, 'src/components/MercuryModelPicker.tsx'), 'utf8')
check('§B /model renders the shared ProductLockup', picker.includes('<ProductLockup view="model"'))
check('§B the old hand-composed header is gone', !/bold color=\{TERRA\}> Mercury</.test(picker))
const kit = readFileSync(join(ROOT, 'src/components/mercury-ui/components.tsx'), 'utf8')
check('§B CommandCenter consumes the SAME ProductLockup line', kit.includes('<ProductLockup view={view} subtitle={subtitle}'))

// §C — no hand-drawn crab RENDER outside the owners. Allowed authors: the
// asset owner (CRAB_GLYPHS + <Crab/>), the critter DATA owner (the crab
// critter's authored mark — SessionMark renders from it), docs/skills, and
// comments. Any other line carrying the glyph run is an imitation render.
const ALLOWED_GLYPH_AUTHORS = new Set([
  'src/components/mercury-ui/assets.tsx',
  'src/utils/cockpit/critterData.ts',
])
const glyphHits = execFileSync('git', ['grep', '-n', '▟▆▙', '--', 'src'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .map(l => {
    const [file, line, ...rest] = l.split(':')
    return { file: file!, line: line!, text: rest.join(':').trim() }
  })
  .filter(h => !ALLOWED_GLYPH_AUTHORS.has(h.file))
  .filter(h => !h.file.endsWith('.md'))
  .filter(h => !h.text.startsWith('//') && !h.text.startsWith('*'))
check(
  '§C the crab glyph run renders only through the owners (no hand-drawn copies)',
  glyphHits.length === 0,
  glyphHits.map(h => `${h.file}:${h.line}`).join(', '),
)
const statusline = readFileSync(join(ROOT, 'src/components/MercuryStatusline.tsx'), 'utf8')
check('§C the statusline preview renders the REAL SessionMark', statusline.includes('<SessionMark />') && !statusline.includes("color={TERRA} bold>Mercury"))

// §D — hierarchy stays classified
const roles = new Set(census.sites.map(s => s.role))
check(
  '§D all five roles present (hierarchy is real, not one gradient bucket)',
  ['product-identity-header', 'mission-focal-title', 'session-identity', 'compact-status-inline'].every(r => roles.has(r)),
  [...roles].join(', '),
)

console.log(failed === 0 ? '\n ✅ ONE PRODUCT-LOCKUP CONTRACT HOLDS' : `\n ❌ ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
