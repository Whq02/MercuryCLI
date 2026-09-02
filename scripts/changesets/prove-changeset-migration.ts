#!/usr/bin/env bun
// ============================================================================
//  scripts/changesets/prove-changeset-migration.ts — F5: Structure (both
//  lanes) and LSP delegate their multi-file COMMIT MECHANICS to the ONE
//  shared change-set core; the duplicated write/rollback/reread machinery
//  is DELETED, and the observable contracts held or deliberately improved:
//    · source pins — the old per-file tmp+rename loops, the unverified
//      rollback, and the LSP plain write loop are ABSENT; all three owners
//      call runVerbatimTextCommit; buildDiffHunks has ONE definition;
//    · behavior — a real Structure apply commits THROUGH the core (a
//      text-change-set journal op with source 'structure'); a mid-walk
//      fault on a multi-file Structure apply now restores originals
//      VERIFIED BY REREAD (the named F5 improvement over the old
//      best-effort rollback); stale refusal preserved.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-mig-home-'))
const csHome = mkdtempSync(join(tmpdir(), 'fulcrum-mig-cs-'))
process.env.MERCURY_CHANGESET_DIR = csHome

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — migration proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const repoRoot = join(import.meta.dir, '..', '..')

console.log('── §1 source pins: ONE commit core, duplicated mechanics DELETED ──')
{
  const transform = readFileSync(join(repoRoot, 'src/services/structure/transform.ts'), 'utf8')
  const polyglot = readFileSync(join(repoRoot, 'src/services/structure/polyglotTransform.ts'), 'utf8')
  const mercuryOps = readFileSync(join(repoRoot, 'src/tools/LSPTool/mercuryOps.ts'), 'utf8')
  check('structure select lane calls the shared core', transform.includes('runVerbatimTextCommit('))
  check('structure polyglot lane calls the shared core', polyglot.includes('runVerbatimTextCommit('))
  check('LSP applyPrepared calls the shared core', mercuryOps.includes('runVerbatimTextCommit('))
  check('the old per-file tmp+rename loop is DELETED (select lane)', !transform.includes('renameSync(tmp'))
  check('the old per-file tmp+rename loop is DELETED (polyglot lane)', !polyglot.includes('renameSync(tmp'))
  check('the old unverified rollback is DELETED', !transform.includes('rollback attempted') && !polyglot.includes('rollback attempted'))
  check('the LSP plain write loop is DELETED', !mercuryOps.includes("await writeFile(p.abs, p.newText, 'utf8')"))
  check('the LSP part-way indeterminate WITHOUT restoration is DELETED', !mercuryOps.includes('Apply PARTIALLY FAILED'))
  const diffBudget = readFileSync(join(repoRoot, 'src/services/changeTransaction/diffBudget.ts'), 'utf8')
  check('buildDiffHunks has ONE definition (diffBudget owner)', diffBudget.includes('export function buildDiffHunks') && !/export function buildDiffHunks/.test(transform))
  check('transform re-exports the shared builder (import seam stable)', transform.includes('export { buildDiffHunks }'))
}

console.log('── §2 a real Structure apply commits THROUGH the core ──')
const { runStructureQuery } = await import('../../src/services/structure/query.ts')
const { buildPreview, applyPreview } = await import('../../src/services/structure/transform.ts')
const { listJournalOperations } = await import('../../src/substrate/operationJournal.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')

const owner = processMainOwner()
const fixture = mkdtempSync(join(tmpdir(), 'fulcrum-mig-fix-'))
mkdirSync(join(fixture, 'src'), { recursive: true })
const F1 = `export function ping() {\n  return legacyCall('ping')\n}\n`
const F2 = `export function pong() {\n  return legacyCall('pong')\n}\n`
writeFileSync(join(fixture, 'src', 'one.ts'), F1)
writeFileSync(join(fixture, 'src', 'two.ts'), F2)

function query() {
  return runStructureQuery(fixture, { select: 'call', callee: 'legacyCall' } as never)
}
{
  const q = query()
  const preview = buildPreview(owner, q as never, undefined, { action: 'replace-callee', to: 'modernCall' } as never)
  check('fixture preview builds (2 files)', 'files' in preview && preview.files.length === 2, JSON.stringify(preview).slice(0, 200))
  if ('files' in preview) {
    const applied = await applyPreview(owner, preview.id)
    check('the apply lands', applied.state === 'applied', JSON.stringify(applied).slice(0, 200))
    check('both files hold the transformed output', readFileSync(join(fixture, 'src', 'one.ts'), 'utf8').includes('modernCall') && readFileSync(join(fixture, 'src', 'two.ts'), 'utf8').includes('modernCall'))
    const ops = await listJournalOperations(join(csHome, 'journal'))
    const committed = ops.filter(o => o.kind === 'text-change-set' && o.state === 'committed')
    check('ONE text-change-set journal op, source structure', committed.length === 1 && (committed[0]!.payload as { source?: string } | undefined)?.source === 'structure')
  }
}

console.log('── §3 mid-walk fault on a Structure apply ⇒ restored + VERIFIED (the F5 improvement) ──')
{
  writeFileSync(join(fixture, 'src', 'one.ts'), F1)
  writeFileSync(join(fixture, 'src', 'two.ts'), F2)
  const q = query()
  const preview = buildPreview(owner, q as never, undefined, { action: 'replace-callee', to: 'faultedCall' } as never)
  check('fault-case preview builds', 'files' in preview && preview.files.length === 2)
  if ('files' in preview) {
    process.env.MERCURY_FAULT_INJECT = `changeset-before-rename@${join(fixture, 'src', 'two.ts')}:throw`
    const out = await applyPreview(owner, preview.id)
    delete process.env.MERCURY_FAULT_INJECT
    check('the midway apply refuses (io class)', out.state === 'refused' && (out as { code?: string }).code === 'io')
    check('the refusal claims VERIFIED restoration', /VERIFIED by reread/.test((out as { reason: string }).reason))
    check('both files hold their EXACT original bytes', readFileSync(join(fixture, 'src', 'one.ts'), 'utf8') === F1 && readFileSync(join(fixture, 'src', 'two.ts'), 'utf8') === F2)
  }
}

console.log('── §4 stale refusal preserved through the core ──')
{
  writeFileSync(join(fixture, 'src', 'one.ts'), F1)
  writeFileSync(join(fixture, 'src', 'two.ts'), F2)
  const q = query()
  const preview = buildPreview(owner, q as never, undefined, { action: 'replace-callee', to: 'staleCall' } as never)
  if ('files' in preview) {
    writeFileSync(join(fixture, 'src', 'two.ts'), `${F2}// drifted\n`)
    const out = await applyPreview(owner, preview.id)
    check('a drifted file still refuses stale (domain check preserved)', out.state === 'refused' && (out as { code?: string }).code === 'stale')
    check('nothing was written on the stale path', readFileSync(join(fixture, 'src', 'one.ts'), 'utf8') === F1)
  }
}

console.log(failures === 0 ? '\nprove-changeset-migration: GREEN' : `\nprove-changeset-migration: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
