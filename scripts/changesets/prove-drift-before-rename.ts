#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'drift-rename-home-'))
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — drift-before-rename proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const commitMod = await import(join(SRC, 'services/changeTransaction/changeSetCommit.ts'))
const { runTextChangeSetCommit, commitPlanDigest } = commitMod
const { sha256Hex } = await import(join(SRC, 'services/changeTransaction/changeSetPlan.ts'))
const { listJournalOperations } = await import(join(SRC, 'substrate/operationJournal.ts'))
const seam = commitMod._setBeforeRenameHookForProofs as ((hook: ((path: string) => void) | null) => void) | undefined
check('the staging-window proof seam exists', typeof seam === 'function')

interface Case { dir: string; csHome: string; paths: string[]; originals: string[]; planned: string[] }
let caseN = 0
function makeCase(): Case {
  caseN++
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `drift-rename-${caseN}-`)))
  const csHome = mkdtempSync(join(tmpdir(), `drift-rename-cs-${caseN}-`))
  const paths: string[] = []
  const originals: string[] = []
  const planned: string[] = []
  for (let i = 0; i < 3; i++) {
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
    return { canonicalPath: p, originalDigest: sha256Hex(originalBytes), plannedDigest: sha256Hex(plannedBytes), originalBytes, plannedBytes, mode: 0o644 }
  })
}
const diskState = (c: Case): string[] =>
  c.paths.map((p, i) => {
    const cur = readFileSync(p, 'utf8')
    return cur === c.originals[i] ? 'original' : cur === c.planned[i] ? 'planned' : 'other'
  })
async function commit(c: Case): Promise<{ kind: string; stalePaths?: string[]; reason?: string }> {
  const targets = targetsOf(c)
  return (await runTextChangeSetCommit({
    ownerKey: `drift-${caseN}`,
    source: 'changeset',
    planDigest: commitPlanDigest(targets),
    targets,
    journalDir: join(c.csHome, 'journal'),
    bundleRoot: join(c.csHome, 'bundles'),
  })) as { kind: string; stalePaths?: string[]; reason?: string }
}
const nonTerminalOps = async (c: Case): Promise<number> =>
  (await listJournalOperations(join(c.csHome, 'journal'))).filter((o: { state: string }) => o.state !== 'committed' && o.state !== 'aborted').length
const noStrayTemps = (c: Case): boolean => readdirSync(c.dir).every(n => !n.endsWith('.tmp'))

console.log('── D1 an external save inside the staging window is drift ──')
{
  const c = makeCase()
  const EXTERNAL = 'the editor saved this while the commit was staging\n'
  let saved = false
  seam?.(path => {
    if (path === c.paths[1] && !saved) {
      saved = true
      writeFileSync(c.paths[1]!, EXTERNAL)
    }
  })
  const out = await commit(c)
  seam?.(null)
  check('the seam fired inside the window', saved)
  check("the outcome is the drift probe's own stale verdict", out.kind === 'stale', JSON.stringify(out))
  check('…naming the drifted path, only it', out.stalePaths?.length === 1 && out.stalePaths[0] === c.paths[1], JSON.stringify(out.stalePaths))
  check("the operator's newer bytes survive", readFileSync(c.paths[1]!, 'utf8') === EXTERNAL, readFileSync(c.paths[1]!, 'utf8'))
  check('the target already renamed is restored, the later one never touched', diskState(c)[0] === 'original' && diskState(c)[2] === 'original', diskState(c).join(','))
  check('the staged temps are swept', noStrayTemps(c))
  check('the journal op settled (nothing left for boot recovery)', (await nonTerminalOps(c)) === 0)
}

console.log('── D2 control: a clean commit still lands ──')
{
  const c = makeCase()
  const out = await commit(c)
  check('committed', out.kind === 'committed', JSON.stringify(out))
  check('every target holds the planned bytes', diskState(c).every(s => s === 'planned'), diskState(c).join(','))
}

console.log(failures === 0 ? '\nprove-drift-before-rename: GREEN' : `\nprove-drift-before-rename: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
