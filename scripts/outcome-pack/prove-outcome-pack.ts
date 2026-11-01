import { randomUUID } from 'node:crypto'
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
const manifest = JSON.parse(readFileSync(join(dirname(dist), 'manifest.json'), 'utf8')) as { buildTree?: string; files?: unknown }
const tree = git(root, ['rev-parse', 'HEAD^{tree}'])
if (manifest.buildTree !== tree) throw new Error(`artifact tree ${manifest.buildTree} differs from HEAD tree ${tree}`)
const artifactDigest = sha256(readFileSync(dist))
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
      check(`${task.id}/${control} ${expected}`, accepted.verdict === expected && !accepted.witness.some(row => row.id === 'cell-execution'), JSON.stringify(accepted.witness.filter(row => !row.ok)))
      let stale = false
      if (accepted.verdict === 'accept') {
        check(`${task.id}/${control} accepted state is current`, acceptanceCurrent(ctx, accepted))
        appendFileSync(join(cwd, task.files[0]!), ' ')
        stale = !acceptanceCurrent(ctx, accepted)
        check(`${task.id}/${control} changed byte invalidates acceptance`, stale)
      }
      writeLedger(ledger, calibrationRow({ task, ctx, control, expected, acceptance: accepted, baseTree, buildTree: tree, artifactDigest, firstCandidate, finalCandidate, changed, start, end: new Date().toISOString(), durationMs: performance.now() - clock, attemptId: randomUUID(), stale }))
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} FAIL`)
process.exitCode = failures === 0 ? 0 : 1
