#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-scribe-scope.ts
//  PROOF (Phase 1): the third `scribe` memory scope — a sibling of the `team`
//  scope under the auto-memory dir — its path contract, the recall EXCLUSION
//  (the core isolation), the off-doctrine line, and the ratify-promote helper.
//  Exercised against the REAL production modules (src/memdir/*), not a reimpl.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-scribe-scope.ts
//
//  Sections (one per Phase-1 task):
//   1.1  getScribeMemPath / getScribeMemEntrypoint path contract
//   1.2  scanMemoryFiles excludes `scribe/` from recall (gated; OFF ⇒ both)
//   1.3  scribeScopeDoctrineLines() — [] when off, teaches "unratified" when on
//   1.4  promoteScribeCandidate() — ratify-promote (programmatic, never auto)
// ============================================================================

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import {
  getScribeMemPath,
  getScribeMemEntrypoint,
  getTeamMemPath,
} from '../../src/memdir/teamMemPaths.js'
import { getAutoMemPath } from '../../src/memdir/paths.js'
import { scanMemoryFiles } from '../../src/memdir/memoryScan.js'
import { scribeScopeDoctrineLines } from '../../src/memdir/scribeScopeDoctrine.js'
import { promoteScribeCandidate } from '../../src/memdir/scribePromote.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

console.log('============================================================')
console.log(' Scribe memory third scope — Phase-1 proof')
console.log('============================================================')

// ── 1.1 — path contract ─────────────────────────────────────────────────────
section('1.1 — getScribeMemPath / getScribeMemEntrypoint (sibling of `team`)')
const auto = getAutoMemPath()
check(
  'getScribeMemPath() === (join(autoMem, "scribe") + sep).normalize(NFC)',
  getScribeMemPath() === (join(auto, 'scribe') + sep).normalize('NFC'),
  getScribeMemPath(),
)
check('getScribeMemPath() ends with "scribe" + sep', getScribeMemPath().endsWith('scribe' + sep))
check('getScribeMemPath() is under the auto-memory dir', getScribeMemPath().startsWith(auto))
check('getScribeMemPath() is DISTINCT from the team scope', getScribeMemPath() !== getTeamMemPath())
check(
  'getScribeMemEntrypoint() === join(autoMem, "scribe", "MEMORY.md")',
  getScribeMemEntrypoint() === join(auto, 'scribe', 'MEMORY.md'),
  getScribeMemEntrypoint(),
)
check('getScribeMemEntrypoint() ends with scribe/MEMORY.md', getScribeMemEntrypoint().endsWith(join('scribe', 'MEMORY.md')))

// ── 1.2 — recall exclusion (the core isolation) ─────────────────────────────
section('1.2 — scanMemoryFiles excludes `scribe/` from recall (gated; OFF ⇒ both)')
const memdir = mkdtempSync(join(tmpdir(), 'hermes-scribe-scope-'))
function mkMem(rel: string, desc: string): void {
  const p = join(memdir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(
    p,
    `---\nname: ${basename(rel, '.md')}\ndescription: ${desc}\nmetadata:\n  type: project\n---\n\nbody`,
  )
}
mkMem('a.md', 'root memory')
mkMem(join('scribe', 'cand.md'), 'unratified candidate')
const sig = new AbortController().signal
const has = (h: { filename: string }[], needle: string): boolean =>
  h.some(x => x.filename.includes(needle))

setStamp(true)
delete process.env.MERCURY_SCRIBE_SCOPE
const onScan = await scanMemoryFiles(memdir, sig)
check('scope ON (fork default): root a.md present', has(onScan, 'a.md'))
check('scope ON (fork default): scribe/cand.md EXCLUDED from recall', !has(onScan, 'cand.md'))

process.env.MERCURY_SCRIBE_SCOPE = '0'
const offScan = await scanMemoryFiles(memdir, sig)
check('MERCURY_SCRIBE_SCOPE=0 ⇒ BOTH returned (byte-identical)', has(offScan, 'a.md') && has(offScan, 'cand.md'))
delete process.env.MERCURY_SCRIBE_SCOPE

// the scope exclusion is stamp-independent.
setStamp(false)
const bareStampScan = await scanMemoryFiles(memdir, sig)
check('bare stamp ⇒ scribe/ STILL excluded (stamp-independence)', has(bareStampScan, 'a.md') && !has(bareStampScan, 'cand.md'))

setStamp(true)
const explicitExclude = await scanMemoryFiles(memdir, sig, ['scribe'])
check('explicit ["scribe"] ⇒ cand excluded', !has(explicitExclude, 'cand.md'))
const explicitNone = await scanMemoryFiles(memdir, sig, [])
check('explicit [] ⇒ BOTH returned (caller override beats gate)', has(explicitNone, 'a.md') && has(explicitNone, 'cand.md'))

const leafScan = await scanMemoryFiles(join(memdir, 'scribe'), sig)
check('steward path: scanning the scribe/ leaf still returns the candidate', has(leafScan, 'cand.md'))

// ── 1.3 — scope doctrine line ([] when off; teaches "unratified" when on) ────
section('1.3 — scribeScopeDoctrineLines() — [] when off, teaches "unratified" when on')
check('scribeScopeDoctrineLines(false) === [] (byte-identical when off)', Array.isArray(scribeScopeDoctrineLines(false)) && scribeScopeDoctrineLines(false).length === 0)
const onDoc = scribeScopeDoctrineLines(true)
check('scribeScopeDoctrineLines(true) is non-empty', onDoc.length > 0)
check('on-doctrine leads with a blank separator (no caller blank needed)', onDoc[0] === '')
check('on-doctrine teaches the scribe scope is "unratified" staging', onDoc.some(l => l.includes('unratified')))
check('on-doctrine teaches it is excluded from recall', onDoc.some(l => /excluded from .*recall|not .*recall/i.test(l)))
check('on-doctrine teaches promotion only by ratification', onDoc.some(l => /ratif/i.test(l)))
// gated default
setStamp(true); delete process.env.MERCURY_SCRIBE_SCOPE
check('fork default ⇒ scribeScopeDoctrineLines() non-empty', scribeScopeDoctrineLines().length > 0)
process.env.MERCURY_SCRIBE_SCOPE = '0'
check('MERCURY_SCRIBE_SCOPE=0 ⇒ scribeScopeDoctrineLines() === []', scribeScopeDoctrineLines().length === 0)
delete process.env.MERCURY_SCRIBE_SCOPE
setStamp(false)
check('bare stamp ⇒ doctrine STILL present (stamp-independence)', scribeScopeDoctrineLines().length > 0)

// ── 1.4 — ratify-promote helper (programmatic, never auto) ──────────────────
section('1.4 — promoteScribeCandidate() moves scribe/<f> → root, indexes, flips approved')
const base = mkdtempSync(join(tmpdir(), 'hermes-scribe-promote-'))
mkdirSync(join(base, 'scribe'), { recursive: true })
const candBody =
  '---\nname: cand-lesson\ndescription: a ratified candidate\nmetadata:\n  type: experience-card\n  approved: false\n---\n\nthe lesson body'
writeFileSync(join(base, 'scribe', 'cand.md'), candBody)

const promoted = await promoteScribeCandidate('cand.md', 'private', { scribeDir: join(base, 'scribe'), rootDir: base })
check('promoteScribeCandidate ok', promoted.ok === true)
check('candidate REMOVED from scribe/', !existsSync(join(base, 'scribe', 'cand.md')))
check('candidate now in ROOT', existsSync(join(base, 'cand.md')))
check('MEMORY.md created in root with a pointer to cand.md', existsSync(join(base, 'MEMORY.md')) && readFileSync(join(base, 'MEMORY.md'), 'utf-8').includes('(cand.md)'))
check('promoted file flipped approved:false → approved:true (ratify lifecycle)', readFileSync(join(base, 'cand.md'), 'utf-8').includes('approved: true'))

// non-destructive: refuse when a target already exists
mkdirSync(join(base, 'scribe'), { recursive: true })
writeFileSync(join(base, 'scribe', 'dup.md'), candBody)
writeFileSync(join(base, 'dup.md'), 'pre-existing root file')
const refused = await promoteScribeCandidate('dup.md', 'private', { scribeDir: join(base, 'scribe'), rootDir: base })
check('refuses when target exists (non-destructive)', refused.ok === false && (refused as { reason: string }).reason === 'target-exists')
check('refused promote left the scribe candidate in place', existsSync(join(base, 'scribe', 'dup.md')))
check('refused promote did NOT clobber the root file', readFileSync(join(base, 'dup.md'), 'utf-8') === 'pre-existing root file')

// missing candidate
const missing = await promoteScribeCandidate('nope.md', 'private', { scribeDir: join(base, 'scribe'), rootDir: base })
check('missing candidate ⇒ not-found', missing.ok === false && (missing as { reason: string }).reason === 'not-found')

// a candidate that gained a secret AFTER staging must NOT promote into
// recall-visible memory (symmetric with both card paths, which re-scan).
mkdirSync(join(base, 'scribe'), { recursive: true })
const secretCand =
  '---\nname: leaky\ndescription: d\nmetadata:\n  type: experience-card\n  approved: false\n---\n\nbody leaks aws_secret_access_key=AKIAIOSFODNN7EXAMPLE'
writeFileSync(join(base, 'scribe', 'leaky.md'), secretCand)
const refusedSecret = await promoteScribeCandidate('leaky.md', 'private', { scribeDir: join(base, 'scribe'), rootDir: base })
check('HB-0097: secret-bearing candidate ⇒ refused (not promoted)', refusedSecret.ok === false && (refusedSecret as { reason: string }).reason === 'secret-bearing')
check('HB-0097: refused-secret candidate stays in scribe scope', existsSync(join(base, 'scribe', 'leaky.md')))
check('HB-0097: refused-secret candidate NOT moved to recall-visible root', !existsSync(join(base, 'leaky.md')))

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL SCRIBE-SCOPE PROOFS PASS')
else console.log(`❌ ${failures} SCRIBE-SCOPE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
