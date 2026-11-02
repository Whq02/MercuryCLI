import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { NODE } from '../daemon/dupline-world.ts'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pack } from './pack.ts'
import { calibrationRow, writeLedger } from './ledger.ts'
import { acceptanceCurrent, digest, git, materialize, sha256, snapshot, type Acceptance, type Context } from './runtime.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const distArg = option('--dist')
if (!distArg) throw new Error('--dist <mercury.mjs> is required')
const dist = resolve(distArg)
const manifest = JSON.parse(readFileSync(join(dirname(dist), 'manifest.json'), 'utf8')) as { buildTree?: string; bundleSha256?: string; bundle?: string }
const tree = git(root, ['rev-parse', 'HEAD^{tree}'])
if (manifest.buildTree !== tree) throw new Error(`artifact tree ${manifest.buildTree} differs from HEAD tree ${tree}`)
const artifactDigest = sha256(readFileSync(dist))
if (manifest.bundle !== basename(dist) || manifest.bundleSha256 !== artifactDigest) throw new Error('artifact bundle differs from its manifest')
const runtimes = { controllerBun: process.versions.bun ?? 'unknown', controllerNodeCompatibility: process.versions.node, productNode: execFileSync(NODE, ['--version'], { encoding: 'utf8' }).trim(), taskNode: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(), dependencies: 'none' }
const selected = option('--task')
const tasks = selected === undefined ? pack : pack.filter(task => task.id === selected)
if (tasks.length === 0) throw new Error(`unknown task ${selected}`)
let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`${checks}. ${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const scratch = mkdtempSync(join(tmpdir(), 'outcome-pack-'))
const ledger = option('--ledger') ?? join(scratch, 'ledger.jsonl')
try {
  for (const task of tasks) {
    const controls = [[task.controls.reference, task.expected.reference], [task.controls.alternative, task.expected.alternative], ...task.controls.wrong.map(path => [path, task.expected.wrong])] as Array<[string, 'accept' | 'refuse']>
    for (const [patch, expected] of controls) {
      if (git(root, ['rev-parse', 'HEAD^{tree}']) !== tree) throw new Error('checkout changed during calibration')
      execFileSync('git', ['diff', '--quiet', 'HEAD'], { cwd: root, stdio: 'pipe' })
      const strays = git(root, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(path => path !== '' && !/^dist(\.|\/|$)/.test(path) && (!path.includes('/') || /^(src|scripts|sdk|docs|vendor)\//.test(path)))
      if (strays.length > 0) throw new Error(`uncommitted files prevent a frozen calibration: ${strays.join(', ')}`)
      const control = basename(patch, '.patch')
      if (!existsSync(patch)) { check(`${task.id}/${control} control exists`, false); continue }
      const start = new Date().toISOString()
      const clock = performance.now()
      const cell = mkdtempSync(join(scratch, `${task.id}-${control}-`))
      const cwd = join(cell, 'repo')
      task.seed(cwd)
      const base = snapshot(cwd)
      const baseTree = git(cwd, ['rev-parse', 'HEAD^{tree}'])
      const ctx: Context = { cwd, scratch: cell, runHome: join(cell, 'home'), dist, files: task.files, protected: Object.fromEntries(Object.entries(base).filter(([path]) => !task.files.includes(path))), evaluatorVersion: task.evaluatorVersion, facts: { runId: '', sessionId: '', exitCode: null, settled: false, ordinaryCheck: false, events: [], effects: {} } }
      let accepted: Acceptance
      try {
        const changes = materialize(cwd, cell, patch, task.files)
        await task.script(ctx, changes)
        accepted = task.evaluator(ctx)
      } catch (error) {
        accepted = { verdict: 'refuse', witness: [{ id: 'cell-execution', ok: false, witness: String(error) }], treeDigest: digest(cwd), checkedPaths: Object.keys(snapshot(cwd)), checkStart: start, checkEnd: new Date().toISOString(), runId: ctx.facts.runId, evaluatorVersion: task.evaluatorVersion }
      }
      const finalCandidate = digest(cwd)
      const firstCandidate = String(ctx.facts.effects.firstCandidateHash ?? finalCandidate)
      const changed = Object.fromEntries(Object.entries(snapshot(cwd)).filter(([path, hash]) => base[path] !== hash))
      const operational = new Set(['protected-files', 'allowed-paths', 'settled-run', 'stable-check-tree', 'cell-execution', 'staleRefused', 'noPartialWrite', 'correctedApplied', 'late-A-stale-after-restart', 'fresh-B-verifies', 'delivered-B', 'explicit-child-stop', 'pendingAskWasPending', 'noUnapprovedContinuation', 'forbiddenAbsent', 'freshAsk', 'absentBeforeFreshApproval', 'authority-order', 'one-approved-write', 'compacted', 'reattached', 'sameBytes', 'sameSession', 'oneRetainedResult'])
      const broken = accepted.witness.filter(row => !row.ok && operational.has(row.id))
      check(`${task.id}/${control} fixture completed`, broken.length === 0 && ctx.facts.runId !== '' && ctx.facts.sessionId !== '', JSON.stringify(broken))
      check(`${task.id}/${control} ${expected}`, accepted.verdict === expected && broken.length === 0, JSON.stringify(accepted.witness.filter(row => !row.ok)))
      const row = { task, ctx, control, expected, acceptance: accepted, baseTree, buildTree: tree, artifactDigest, runtimes, firstCandidate, finalCandidate, changed, start, end: new Date().toISOString(), durationMs: performance.now() - clock, attemptId: randomUUID(), stale: false }
      writeLedger(ledger, calibrationRow(row))
      if (broken.length > 0) break
      if (accepted.verdict === 'accept') {
        check(`${task.id}/${control} accepted state is current`, acceptanceCurrent(ctx, accepted))
        appendFileSync(join(cwd, task.files[0]!), ' ')
        const stale = !acceptanceCurrent(ctx, accepted)
        check(`${task.id}/${control} changed byte invalidates acceptance`, stale)
        const staleResult: Acceptance = { ...accepted, verdict: stale ? 'refuse' : 'accept', witness: [{ id: 'old-acceptance-does-not-cover-new-bytes', ok: stale, witness: `${accepted.treeDigest} -> ${digest(cwd)}` }] }
        writeLedger(ledger, calibrationRow({ ...row, control: `${control}/stale`, expected: 'refuse', acceptance: staleResult, finalCandidate: digest(cwd), changed: Object.fromEntries(Object.entries(snapshot(cwd)).filter(([path, hash]) => base[path] !== hash)), end: new Date().toISOString(), durationMs: performance.now() - clock, attemptId: randomUUID(), stale }))
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} FAIL`)
process.exitCode = failures === 0 ? 0 : 1
