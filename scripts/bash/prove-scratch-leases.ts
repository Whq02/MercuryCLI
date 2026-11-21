#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP_SCRATCH = mkdtempSync(join(tmpdir(), 'lease-tmp-'))
process.env.MERCURY_TMPDIR = TMP_SCRATCH

const ROOT = join(import.meta.dir, '..', '..')
const { registerScratchLease, releaseScratchLease, listScratchLeftovers } = await import(
  join(ROOT, 'src/utils/scratchLeases.ts')
)
const { getProjectTempDir } = await import(join(ROOT, 'src/utils/permissions/filesystem.ts'))

let failures = 0
const LEASES_FILE = 'src/utils/scratchLeases.ts'
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, fix].filter(part => part !== '').join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
}

console.log('============================================================')
console.log(' Scratch leases (seamark SM-H / SM-06) — proof')
console.log('============================================================')

try {
  const projTemp = getProjectTempDir()
  mkdirSync(projTemp, { recursive: true })
  check('project temp dir is inside the pinned scratch (hygiene sanity)', realpathSync(projTemp).startsWith(realpathSync(TMP_SCRATCH)), projTemp, 'change getProjectTempDir in src/utils/permissions/filesystem.ts so it honours MERCURY_TMPDIR')

  const root1 = join(projTemp, 'agent-a-scratch')
  mkdirSync(root1, { recursive: true })
  writeFileSync(join(root1, 'blob.bin'), 'x'.repeat(64 * 1024))
  const l1 = registerScratchLease({ kind: 'agent', id: 'agent-a' }, root1)
  const l1b = registerScratchLease({ kind: 'agent', id: 'agent-a' }, root1)
  check('registration is idempotent per (owner, root)', l1.leaseId === l1b.leaseId, '', `change registerScratchLease in ${LEASES_FILE} so a second registration of the same owner and root returns the first lease`)

  const leftovers = listScratchLeftovers()
  const mine = leftovers.find(l => l.leaseId === l1.leaseId)
  check('leftover inventoried with owner + size + recovery', !!mine && mine.owner.id === 'agent-a' && mine.sizeBytes >= 64 * 1024 && mine.recovery.length > 0, JSON.stringify(mine)?.slice(0, 110), `change listScratchLeftovers and registerScratchLease in ${LEASES_FILE} (owner, sizeBytes and recovery of each lease)`)

  const rel = releaseScratchLease(l1.leaseId)
  check('release cleans the leased root exactly', rel.released && rel.cleaned && !existsSync(root1), JSON.stringify(rel), `change releaseScratchLease in ${LEASES_FILE} so it removes exactly the leased root`)
  check('released lease leaves the inventory', !listScratchLeftovers().some(l => l.leaseId === l1.leaseId), '', `change releaseScratchLease or listScratchLeftovers in ${LEASES_FILE} so a released lease leaves the inventory`)

  const outside = mkdtempSync(join(tmpdir(), 'lease-outside-'))
  writeFileSync(join(outside, 'keep.txt'), 'precious')
  const l2 = registerScratchLease({ kind: 'task', id: 'task-x' }, outside)
  const rel2 = releaseScratchLease(l2.leaseId)
  check('containment guard REFUSES to delete outside the project temp dir', rel2.released && !rel2.cleaned && /OUTSIDE/.test(rel2.refusal ?? '') && existsSync(join(outside, 'keep.txt')), JSON.stringify(rel2).slice(0, 120), `change the containment check in releaseScratchLease in ${LEASES_FILE}: a root outside the project temp dir must be refused with OUTSIDE in the refusal`)
  rmSync(outside, { recursive: true, force: true })

  const root3 = join(projTemp, 'preserved-artifacts')
  mkdirSync(root3, { recursive: true })
  const l3 = registerScratchLease({ kind: 'session', id: 's-1' }, root3, { cleanupPolicy: 'preserve', recovery: 'operator artifacts — review before deleting' })
  const rel3 = releaseScratchLease(l3.leaseId)
  check("'preserve' policy keeps the root on release", rel3.released && !rel3.cleaned && existsSync(root3), '', `change releaseScratchLease in ${LEASES_FILE} so a preserve lease is not cleaned`)

  const { buildSubagentMercurySections } = await import(join(ROOT, 'src/constants/subagentDoctrine.ts'))
  const doctrine = buildSubagentMercurySections({ agentDefinition: { agentType: 'mercury-crew' } }).join('\n')
  check('subagent doctrine briefs scratch discipline (the ONE seam)',
    doctrine.includes('under your session scratchpad') &&
    doctrine.includes('never bare /tmp or the project tree') &&
    /delet\w* what your run created/i.test(doctrine),
    '', 'change the scratch lines of the crewmate doctrine in src/prompt/mercuryContract.ts, which buildSubagentMercurySections in src/constants/subagentDoctrine.ts serves')
  const { crewChecks } = await import(join(ROOT, 'src/services/health/sections/crew.ts'))
  const leasesRow = crewChecks().find((row: { id: string }) => row.id === 'scratch-leases')
  const rootH = join(projTemp, 'health-row-scratch')
  mkdirSync(rootH, { recursive: true })
  const lH = registerScratchLease({ kind: 'agent', id: 'agent-h' }, rootH)
  const held = await leasesRow?.run()
  releaseScratchLease(lH.leaseId)
  check('/health lists leftovers lease-exact', held?.status === 'warn' && held.evidence.includes(rootH) && held.fix === 'Delete only the named lease paths, not all of /tmp.', JSON.stringify(held), 'change the scratch-leases row in src/services/health/sections/crew/scratch.ts')
} finally {
  rmSync(TMP_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL SCRATCH-LEASE PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
