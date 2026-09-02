#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'comp-iso-home-'))
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compensation isolation proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { runTextChangeSetCommit, recoverChangeSetJournal, commitPlanDigest } = await import(join(SRC, 'services/changeTransaction/changeSetCommit.ts'))
const { sha256Hex } = await import(join(SRC, 'services/changeTransaction/changeSetPlan.ts'))
const { listJournalOperations } = await import(join(SRC, 'substrate/operationJournal.ts'))

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'comp-iso-')))
const csHome = mkdtempSync(join(tmpdir(), 'comp-iso-cs-'))
const paths: string[] = []
const originals: string[] = []
const planned: string[] = []
for (let i = 0; i < 3; i++) {
  const p = join(dir, `f${i}.txt`)
  const o = `original-${i}\nline2\n`
  writeFileSync(p, o)
  paths.push(p)
  originals.push(o)
  planned.push(`planned-${i}\nline2\n`)
}
const targets = paths.map((p, i) => {
  const originalBytes = Buffer.from(originals[i]!, 'utf8')
  const plannedBytes = Buffer.from(planned[i]!, 'utf8')
  return { canonicalPath: p, originalDigest: sha256Hex(originalBytes), plannedDigest: sha256Hex(plannedBytes), originalBytes, plannedBytes, mode: 0o644 }
})
const diskState = (): string[] =>
  paths.map((p, i) => {
    const cur = readFileSync(p, 'utf8')
    return cur === originals[i] ? 'original' : cur === planned[i] ? 'planned' : 'other'
  })
const nonTerminalOps = async (): Promise<number> =>
  (await listJournalOperations(join(csHome, 'journal'))).filter((o: { state: string }) => o.state !== 'committed' && o.state !== 'aborted').length
const noStrayTemps = (): boolean => readdirSync(dir).every(n => !n.endsWith('.tmp'))

console.log('── C1 a throwing restore on the MIDDLE target leaves only that target ──')
process.env.MERCURY_FAULT_INJECT = `changeset-during-reread@${paths[2]}:throw;changeset-during-compensate@${paths[1]}:eperm`
let out: { kind: string; landedPaths?: string[]; divergedPaths?: string[]; reason?: string }
try {
  out = (await runTextChangeSetCommit({
    ownerKey: 'comp-iso',
    source: 'changeset',
    planDigest: commitPlanDigest(targets),
    targets,
    journalDir: join(csHome, 'journal'),
    bundleRoot: join(csHome, 'bundles'),
  })) as typeof out
} finally {
  delete process.env.MERCURY_FAULT_INJECT
}
check('the outcome is indeterminate (one path could not be restored)', out.kind === 'indeterminate', JSON.stringify(out))
check('the targets on BOTH sides of the failing one are restored', diskState()[0] === 'original' && diskState()[2] === 'original', diskState().join(','))
check('only the failing target keeps the planned bytes, intact', diskState()[1] === 'planned', diskState().join(','))
check('the landed list names exactly it, nothing diverged', out.landedPaths?.length === 1 && out.landedPaths[0] === paths[1] && out.divergedPaths?.length === 0, JSON.stringify({ landed: out.landedPaths, diverged: out.divergedPaths }))
check('the reason names the path, the errno, and that the planned bytes are still in place', (out.reason ?? '').includes(paths[1]!) && /EPERM/.test(out.reason ?? '') && /planned bytes are still in place/.test(out.reason ?? ''), out.reason)
check('the staged temps are swept', noStrayTemps())
check('the journal op is retained non-terminal for boot recovery', (await nonTerminalOps()) === 1)

console.log('── C2 boot recovery settles the one remaining path ──')
{
  const summary = await recoverChangeSetJournal({ journalDir: join(csHome, 'journal'), bundleRoot: join(csHome, 'bundles') })
  check('recovery compensates the remaining path (verified)', summary.compensated.length === 1 && diskState().every(s => s === 'original'), `${JSON.stringify(summary)} ${diskState().join(',')}`)
  const second = await recoverChangeSetJournal({ journalDir: join(csHome, 'journal'), bundleRoot: join(csHome, 'bundles') })
  check('a second recovery run is a no-op', second.rolledForward.length === 0 && second.compensated.length === 0 && second.unrecoverable.length === 0)
}

console.log('── C3 the two classes are separated (source pin) ──')
{
  const src = readFileSync(join(SRC, 'services/changeTransaction/changeSetCommit.ts'), 'utf8')
  const cls = src.slice(src.indexOf('class ChangeSetCompensationIncomplete'), src.indexOf('class ChangeSetCompensationIncomplete') + 1200)
  check('the error carries the unrestored paths with their reasons', cls.includes('readonly unrestored: Array<{ path: string; reason: string }>'))
  check('…and speaks the two classes in two sentences', cls.includes('the planned bytes are still in place there') && cls.includes('later bytes nobody may overwrite'))
  const closure = src.slice(src.indexOf('const compensate = async'), src.indexOf('const compensate = async') + 2600)
  check('the compensate walk records a throwing restore and continues', closure.includes('unrestored.push({ path: t.canonicalPath, reason:') && closure.includes('} catch (restoreError) {'))
}

console.log(failures === 0 ? '\nprove-compensation-isolation: GREEN' : `\nprove-compensation-isolation: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
