#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_SCRATCH = mkdtempSync(join(tmpdir(), 'lease-tmp-'))
process.env.MERCURY_TMPDIR = TMP_SCRATCH

const ROOT = join(import.meta.dir, '..', '..')
const { registerScratchLease, releaseScratchLease, listScratchLeftovers } = await import(
  join(ROOT, 'src/platform/files/scratchLeases.ts')
)
const { getProjectTempDir } = await import(join(ROOT, 'src/permissions/rules/filesystem.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}

console.log('============================================================')
console.log(' Scratch leases (seamark SM-H / SM-06) — proof')
console.log('============================================================')

try {
  const projTemp = getProjectTempDir()
  mkdirSync(projTemp, { recursive: true })
  check('project temp dir is inside the pinned scratch (hygiene sanity)', realpathSync(projTemp).startsWith(realpathSync(TMP_SCRATCH)), projTemp, 'getProjectTempDir in src/permissions/rules/filesystem.ts must resolve under the directory named by MERCURY_TMPDIR')

  const root1 = join(projTemp, 'agent-a-scratch')
  mkdirSync(root1, { recursive: true })
  writeFileSync(join(root1, 'blob.bin'), 'x'.repeat(64 * 1024))
  const l1 = registerScratchLease({ kind: 'agent', id: 'agent-a' }, root1)
  const l1b = registerScratchLease({ kind: 'agent', id: 'agent-a' }, root1)
  check('registration is idempotent per (owner, root)', l1.leaseId === l1b.leaseId, '', 'registerScratchLease in src/platform/files/scratchLeases.ts must return the existing lease when the same owner registers the same root again')

  const leftovers = listScratchLeftovers()
  const mine = leftovers.find(l => l.leaseId === l1.leaseId)
  check('leftover inventoried with owner + size + recovery', !!mine && mine.owner.id === 'agent-a' && mine.sizeBytes >= 64 * 1024 && mine.recovery.length > 0, JSON.stringify(mine)?.slice(0, 110), 'listScratchLeftovers in src/platform/files/scratchLeases.ts must return each live lease with its owner, its size in bytes and a non-empty recovery text')

  const rel = releaseScratchLease(l1.leaseId)
  check('release cleans the leased root exactly', rel.released && rel.cleaned && !existsSync(root1), JSON.stringify(rel), 'releaseScratchLease in src/platform/files/scratchLeases.ts must delete a leased root that lies inside the project temp dir and report released and cleaned')
  check('released lease leaves the inventory', !listScratchLeftovers().some(l => l.leaseId === l1.leaseId), '', 'releaseScratchLease in src/platform/files/scratchLeases.ts must drop the lease so listScratchLeftovers no longer returns it')

  const outside = mkdtempSync(join(tmpdir(), 'lease-outside-'))
  writeFileSync(join(outside, 'keep.txt'), 'precious')
  const l2 = registerScratchLease({ kind: 'task', id: 'task-x' }, outside)
  const rel2 = releaseScratchLease(l2.leaseId)
  check('containment guard REFUSES to delete outside the project temp dir', rel2.released && !rel2.cleaned && /OUTSIDE/.test(rel2.refusal ?? '') && existsSync(join(outside, 'keep.txt')), JSON.stringify(rel2).slice(0, 120), 'releaseScratchLease in src/platform/files/scratchLeases.ts must refuse to delete a root outside the project temp dir, return a refusal naming OUTSIDE, and leave the files')
  rmSync(outside, { recursive: true, force: true })

  const root3 = join(projTemp, 'preserved-artifacts')
  mkdirSync(root3, { recursive: true })
  const l3 = registerScratchLease({ kind: 'session', id: 's-1' }, root3, { cleanupPolicy: 'preserve', recovery: 'operator artifacts — review before deleting' })
  const rel3 = releaseScratchLease(l3.leaseId)
  check("'preserve' policy keeps the root on release", rel3.released && !rel3.cleaned && existsSync(root3), '', 'releaseScratchLease in src/platform/files/scratchLeases.ts must honour cleanupPolicy preserve by releasing the lease without deleting the root')

  const { buildCrewmateMercurySections } = await import(join(ROOT, 'src/tools/crewmate/crewmateDoctrine.ts'))
  const doctrine = buildCrewmateMercurySections({ agentDefinition: { agentType: 'mercury-crew' } }).join('\n')
  check('subagent doctrine briefs scratch discipline (the ONE seam)',
    doctrine.includes('under your session scratchpad') &&
    doctrine.includes('never bare /tmp or the project tree') &&
    /delet\w* what your run created/i.test(doctrine), '', 'buildCrewmateMercurySections in src/tools/crewmate/crewmateDoctrine.ts must include the scratch rules: use the session scratchpad, never bare /tmp or the project tree, delete what the run created')
  const { crewChecks } = await import(join(ROOT, 'src/platform/health/sections/crew.ts'))
  const leasesRow = crewChecks().find((row: { id: string }) => row.id === 'scratch-leases')
  const rootH = join(projTemp, 'health-row-scratch')
  mkdirSync(rootH, { recursive: true })
  const lH = registerScratchLease({ kind: 'agent', id: 'agent-h' }, rootH)
  const held = await leasesRow?.run()
  releaseScratchLease(lH.leaseId)
  check('/health lists leftovers lease-exact', held?.status === 'warn' && held.evidence.includes(rootH) && held.fix === 'Delete only the named lease paths, not all of /tmp.', JSON.stringify(held), 'the scratch-leases row in src/platform/health/sections/crew/scratch.ts must return status warn with the leased root in evidence and the fix text Delete only the named lease paths, not all of /tmp.')
} finally {
  rmSync(TMP_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL SCRATCH-LEASE PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
