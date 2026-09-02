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
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('============================================================')
console.log(' Scratch leases (seamark SM-H / SM-06) — proof')
console.log('============================================================')

try {
  const projTemp = getProjectTempDir()
  mkdirSync(projTemp, { recursive: true })
  check('project temp dir is inside the pinned scratch (hygiene sanity)', realpathSync(projTemp).startsWith(realpathSync(TMP_SCRATCH)), projTemp)

  const root1 = join(projTemp, 'agent-a-scratch')
  mkdirSync(root1, { recursive: true })
  writeFileSync(join(root1, 'blob.bin'), 'x'.repeat(64 * 1024))
  const l1 = registerScratchLease({ kind: 'agent', id: 'agent-a' }, root1)
  const l1b = registerScratchLease({ kind: 'agent', id: 'agent-a' }, root1)
  check('registration is idempotent per (owner, root)', l1.leaseId === l1b.leaseId)

  const leftovers = listScratchLeftovers()
  const mine = leftovers.find(l => l.leaseId === l1.leaseId)
  check('leftover inventoried with owner + size + recovery', !!mine && mine.owner.id === 'agent-a' && mine.sizeBytes >= 64 * 1024 && mine.recovery.length > 0, JSON.stringify(mine)?.slice(0, 110))

  const rel = releaseScratchLease(l1.leaseId)
  check('release cleans the leased root exactly', rel.released && rel.cleaned && !existsSync(root1), JSON.stringify(rel))
  check('released lease leaves the inventory', !listScratchLeftovers().some(l => l.leaseId === l1.leaseId))

  const outside = mkdtempSync(join(tmpdir(), 'lease-outside-'))
  writeFileSync(join(outside, 'keep.txt'), 'precious')
  const l2 = registerScratchLease({ kind: 'task', id: 'task-x' }, outside)
  const rel2 = releaseScratchLease(l2.leaseId)
  check('containment guard REFUSES to delete outside the project temp dir', rel2.released && !rel2.cleaned && /OUTSIDE/.test(rel2.refusal ?? '') && existsSync(join(outside, 'keep.txt')), JSON.stringify(rel2).slice(0, 120))
  rmSync(outside, { recursive: true, force: true })

  const root3 = join(projTemp, 'preserved-artifacts')
  mkdirSync(root3, { recursive: true })
  const l3 = registerScratchLease({ kind: 'session', id: 's-1' }, root3, { cleanupPolicy: 'preserve', recovery: 'operator artifacts — review before deleting' })
  const rel3 = releaseScratchLease(l3.leaseId)
  check("'preserve' policy keeps the root on release", rel3.released && !rel3.cleaned && existsSync(root3))

  const { readFileSync } = await import('node:fs')
  const doctrine = readFileSync(join(ROOT, 'src/constants/subagentDoctrine.ts'), 'utf8')
  check('subagent doctrine briefs scratch discipline (the ONE seam)',
    doctrine.includes('session scratchpad directory') &&
    doctrine.includes('never bare /tmp or the project tree') &&
    /delete what your run created/i.test(doctrine))
  const fsSrc = readFileSync(join(ROOT, 'src/utils/permissions/filesystem.ts'), 'utf8')
  check('session scratchpads auto-register their lease', fsSrc.includes('registerScratchLease'))
  const doctorSrc = readFileSync(join(ROOT, 'src/utils/healthReport.ts'), 'utf8')
  check('the doctor lists leftovers lease-exact', doctorSrc.includes("id: 'scratch-leases'") && doctorSrc.includes('never a broad /tmp sweep'))
} finally {
  rmSync(TMP_SCRATCH, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n ✅ ALL SCRATCH-LEASE PROOFS PASS' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
