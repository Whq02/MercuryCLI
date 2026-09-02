#!/usr/bin/env bun
// ============================================================================
//  scripts/changesets/prove-changeset-recovery.ts — FC9: interruption at EVERY
//  boundary of the shared commit walk, deterministic (fault seams + digest
//  probes, no wall-clock sleeps):
//
//  In-process throws:
//    · before the bundle · after staging a target · before the journal ·
//      before a mid-walk rename (compensation restores + verifies) ·
//      during reread · during compensation itself (honest indeterminate,
//      boot recovery settles);
//  Child-process SIGKILL (real death):
//    · after journal prepare (nothing renamed ⇒ compensated/aborted);
//    · after the first commit step (subset ⇒ bundle compensation, verified);
//    · before the commit marker (all landed ⇒ roll-forward, then a re-run
//      of the SAME plan replays across the process boundary);
//    · landed-then-mutated (later bytes ⇒ unresolved: NEVER overwritten,
//      evidence retained, settles once the operator restores);
//    · death DURING recovery compensation ⇒ second recovery completes
//      (idempotent).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fulcrum-rec-home-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — recovery proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const { runTextChangeSetCommit, recoverChangeSetJournal, commitPlanDigest } = await import(
  '../../src/services/changeTransaction/changeSetCommit.ts'
)
const { sha256Hex } = await import('../../src/services/changeTransaction/changeSetPlan.ts')
const { listJournalOperations } = await import('../../src/substrate/operationJournal.ts')

const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
const DRIVER = join(import.meta.dir, 'fixtures', 'commit-driver.ts')

interface Case {
  dir: string
  csHome: string
  paths: string[]
  originals: string[]
  planned: string[]
}
let caseN = 0
function makeCase(n = 3): Case {
  caseN++
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `fulcrum-rec-${caseN}-`)))
  const csHome = mkdtempSync(join(tmpdir(), `fulcrum-rec-cs-${caseN}-`))
  const paths: string[] = []
  const originals: string[] = []
  const planned: string[] = []
  for (let i = 0; i < n; i++) {
    const p = join(dir, `f${i}.txt`)
    const o = `original-${caseN}-${i}\nline2\n`
    writeFileSync(p, o)
    paths.push(p)
    originals.push(o)
    planned.push(`planned-${caseN}-${i}\nline2\n`)
  }
  return { dir, csHome, paths, originals, planned }
}
function targetsOf(c: Case) {
  return c.paths.map((p, i) => {
    const originalBytes = Buffer.from(c.originals[i]!, 'utf8')
    const plannedBytes = Buffer.from(c.planned[i]!, 'utf8')
    return {
      canonicalPath: p,
      originalDigest: sha256Hex(originalBytes),
      plannedDigest: sha256Hex(plannedBytes),
      originalBytes,
      plannedBytes,
      mode: 0o644,
    }
  })
}
function diskState(c: Case): string[] {
  return c.paths.map((p, i) => {
    const cur = readFileSync(p, 'utf8')
    return cur === c.originals[i] ? 'original' : cur === c.planned[i] ? 'planned' : 'other'
  })
}
async function commitInProcess(c: Case, fault: string | undefined) {
  if (fault !== undefined) process.env.MERCURY_FAULT_INJECT = fault
  else delete process.env.MERCURY_FAULT_INJECT
  try {
    const targets = targetsOf(c)
    return await runTextChangeSetCommit({
      ownerKey: `rec-${caseN}`,
      source: 'changeset',
      planDigest: commitPlanDigest(targets),
      targets,
      journalDir: join(c.csHome, 'journal'),
      bundleRoot: join(c.csHome, 'bundles'),
    })
  } finally {
    delete process.env.MERCURY_FAULT_INJECT
  }
}
function commitInChild(
  c: Case,
  fault: string,
  opts: { pinOriginals?: boolean; ownerKey?: string } = {},
): { signal: string | null; stdout: string } {
  const specPath = join(c.dir, 'driver-spec.json')
  writeFileSync(
    specPath,
    JSON.stringify({
      csHome: c.csHome,
      ownerKey: opts.ownerKey ?? `rec-child-${caseN}`,
      files: c.paths.map((p, i) => ({
        path: p,
        to: c.planned[i]!,
        ...(opts.pinOriginals ? { from: c.originals[i]! } : {}),
      })),
    }),
  )
  const res = spawnSync(bun, [DRIVER, specPath], {
    env: { ...process.env, MERCURY_FAULT_INJECT: fault },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { signal: res.signal, stdout: res.stdout ?? '' }
}
async function recover(c: Case) {
  delete process.env.MERCURY_FAULT_INJECT
  return recoverChangeSetJournal({ journalDir: join(c.csHome, 'journal'), bundleRoot: join(c.csHome, 'bundles') })
}
async function nonTerminalOps(c: Case) {
  return (await listJournalOperations(join(c.csHome, 'journal'))).filter(
    o => o.state !== 'committed' && o.state !== 'aborted',
  )
}
function noStrayTemps(c: Case): boolean {
  return readdirSync(c.dir).every(n => !n.endsWith('.tmp'))
}

console.log('── R1 in-process throws before any rename ⇒ failed-restored, zero writes ──')
for (const [fault, label] of [
  ['changeset-before-bundle:throw', 'before the recovery bundle'],
  ['changeset-after-stage:throw', 'after staging a target'],
  ['changeset-before-journal:throw', 'before the journal record'],
] as const) {
  const c = makeCase()
  const out = await commitInProcess(c, fault)
  check(`${label}: failed with complete restoration`, out.kind === 'failed-restored', JSON.stringify(out))
  check(`${label}: disk fully original`, diskState(c).every(s => s === 'original'))
  check(`${label}: no staged temps left`, noStrayTemps(c))
}

console.log('── R2 mid-walk rename failure ⇒ compensation restores + verifies ──')
{
  const c = makeCase()
  const out = await commitInProcess(c, `changeset-before-rename@${c.paths[1]}:throw`)
  check('failed-restored after a mid-walk rename fault', out.kind === 'failed-restored', JSON.stringify(out))
  check('ALL targets back at original bytes (verified by the walk)', diskState(c).every(s => s === 'original'))
  check('no staged temps left', noStrayTemps(c))
  check('the journal op settled aborted', (await nonTerminalOps(c)).length === 0)
}

console.log('── R3 reread fault ⇒ compensation restores; disk truth classifies ──')
{
  const c = makeCase()
  const out = await commitInProcess(c, `changeset-during-reread@${c.paths[2]}:throw`)
  check('reread fault classifies failed-restored (all originals verified)', out.kind === 'failed-restored', JSON.stringify(out))
  check('disk fully original after reread-fault compensation', diskState(c).every(s => s === 'original'))
}

console.log('── R4 fault DURING compensation ⇒ honest indeterminate, boot recovery settles ──')
{
  const c = makeCase()
  const out = await commitInProcess(
    c,
    `changeset-before-rename@${c.paths[2]}:throw;changeset-during-compensate@${c.paths[0]}:throw`,
  )
  check('outcome is indeterminate (compensation interrupted)', out.kind === 'indeterminate', JSON.stringify(out))
  check(
    'landed paths named exactly (planned bytes remaining)',
    out.kind === 'indeterminate' && out.landedPaths.length === 1 && out.landedPaths[0] === c.paths[0] && out.divergedPaths.length === 0,
  )
  check('the journal op is RETAINED non-terminal for boot recovery', (await nonTerminalOps(c)).length === 1)
  const summary = await recover(c)
  check('boot recovery compensates the remaining subset (verified)', summary.compensated.length === 1 && diskState(c).every(s => s === 'original'))
  const second = await recover(c)
  check('a second recovery run is a no-op (idempotent)', second.rolledForward.length === 0 && second.compensated.length === 0 && second.unrecoverable.length === 0)
}

console.log('── R5 child SIGKILL after journal prepare ⇒ aborted, zero writes ──')
{
  const c = makeCase()
  const r = commitInChild(c, 'journal-after-prepare:kill')
  check('the child died by SIGKILL', r.signal === 'SIGKILL')
  check('nothing renamed before death', diskState(c).every(s => s === 'original'))
  const summary = await recover(c)
  check('recovery settles the op (nothing to restore)', summary.compensated.length === 1 && (await nonTerminalOps(c)).length === 0)
  check('disk fully original + temps swept', diskState(c).every(s => s === 'original') && noStrayTemps(c))
}

console.log('── R6 child SIGKILL after the FIRST commit step ⇒ bundle compensation ──')
{
  const c = makeCase()
  const r = commitInChild(c, 'journal-after-step@commit-0:kill')
  check('the child died by SIGKILL mid-walk', r.signal === 'SIGKILL')
  check('exactly the first target landed before death', JSON.stringify(diskState(c)) === JSON.stringify(['planned', 'original', 'original']))
  const summary = await recover(c)
  check('recovery compensates the applied subset FROM THE BUNDLE (verified)', summary.compensated.length === 1)
  check('disk fully original after recovery', diskState(c).every(s => s === 'original'))
  const second = await recover(c)
  check('second restart is idempotent', second.compensated.length === 0 && second.unrecoverable.length === 0)
}

console.log('── R7 child SIGKILL before the commit marker ⇒ roll-forward + cross-process replay ──')
{
  const c = makeCase()
  const r = commitInChild(c, 'journal-before-commit:kill')
  check('the child died by SIGKILL after all renames', r.signal === 'SIGKILL')
  check('every target holds planned bytes', diskState(c).every(s => s === 'planned'))
  const summary = await recover(c)
  check('recovery ROLLS FORWARD to committed', summary.rolledForward.length === 1)
  check('disk stays planned after roll-forward', diskState(c).every(s => s === 'planned'))
  // The SAME plan (same digest — original bytes pinned) re-run in a fresh
  // process must REPLAY, not re-write. The child owner key must match the
  // committing run's (replay is owner-scoped).
  const again = commitInChild(c, '', { pinOriginals: true, ownerKey: `rec-child-${caseN}` })
  check('re-running the same plan replays across processes', /"kind":"replayed"/.test(again.stdout), again.stdout)
}

console.log('── R8 later bytes are NEVER overwritten by recovery ──')
{
  const c = makeCase()
  const r = commitInChild(c, 'journal-after-step@commit-0:kill')
  check('setup: first target landed', r.signal === 'SIGKILL' && diskState(c)[0] === 'planned')
  writeFileSync(c.paths[0]!, 'THIRD-PARTY BYTES\n')
  const summary = await recover(c)
  check('recovery reports the exact unresolved path', summary.unrecoverable.length === 1)
  check('the later bytes are untouched', readFileSync(c.paths[0]!, 'utf8') === 'THIRD-PARTY BYTES\n')
  check('the op + bundle are retained as evidence', (await nonTerminalOps(c)).length === 1 && existsSync(join(c.csHome, 'bundles')))
  const second = await recover(c)
  check('repeat recovery stays unresolved (idempotent, still untouched)', second.unrecoverable.length === 1 && readFileSync(c.paths[0]!, 'utf8') === 'THIRD-PARTY BYTES\n')
  // Operator settles the file back to its original — recovery now completes.
  writeFileSync(c.paths[0]!, c.originals[0]!)
  const third = await recover(c)
  check('once settled, recovery compensates and closes the op', third.compensated.length === 1 && (await nonTerminalOps(c)).length === 0)
}

console.log('── R9 death DURING recovery ⇒ the next recovery completes ──')
{
  const c = makeCase()
  const r = commitInChild(c, 'journal-after-step@commit-0:kill')
  check('setup: first target landed', r.signal === 'SIGKILL' && diskState(c)[0] === 'planned')
  // First recovery attempt dies mid-compensation (in-process throw at the
  // restore boundary — the same code path a SIGKILL would cut).
  process.env.MERCURY_FAULT_INJECT = `changeset-during-compensate@${c.paths[0]}:throw`
  const interrupted = await recoverChangeSetJournal({ journalDir: join(c.csHome, 'journal'), bundleRoot: join(c.csHome, 'bundles') })
  delete process.env.MERCURY_FAULT_INJECT
  check('the interrupted recovery reports, never lies', interrupted.unrecoverable.length === 1)
  const clean = await recover(c)
  check('the NEXT recovery completes the compensation', clean.compensated.length === 1 && diskState(c).every(s => s === 'original'))
}

console.log(failures === 0 ? '\nprove-changeset-recovery: GREEN' : `\nprove-changeset-recovery: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
