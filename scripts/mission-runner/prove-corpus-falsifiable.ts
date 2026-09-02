// ============================================================================
//  prove-corpus-falsifiable.ts — the corpus falsifiability law, mechanically.
// ----------------------------------------------------------------------------
//  For EVERY task:
//    BEFORE     the untouched task state must be REJECTED by its grader
//               (fails-before-repair, or the no-change oracle refuses an
//               empty report);
//    REFERENCE  the known-good solution must be ACCEPTED (the grader is
//               satisfiable — an unsatisfiable grader is a corpus bug);
//    FALSIFY    every recorded plausible-wrong variant must be REJECTED
//               (test tampering, decoy renames, naive threshold fixes …).
//
//  Runs the REAL check commands (node --test / python unittest) against
//  deterministically seeded repo states. No model calls. gate-class: cpu.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { HelixSolutionVariant, HelixTask } from './corpus/contracts.js'
import { HELIX_TASKS } from './corpus/tasks.js'
import { gradeTask } from './corpus/grade.js'
import { seedAll, type SeededRepo } from './corpus/seed.js'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)
const scratch = mkdtempSync(join(tmpdir(), 'helix-falsify-'))
const started = Date.now()

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function materialize(seeded: SeededRepo, task: HelixTask, label: string): { dir: string; baseSha: string } {
  const dir = join(scratch, 'states', task.id + '-' + label)
  mkdirSync(dirname(dir), { recursive: true })
  git(['clone', '-q', seeded.dir, dir], scratch)
  const sha = task.ref.kind === 'sha' ? task.ref.value : seeded.refs[task.ref.value]
  if (!sha) throw new Error(task.id + ': unknown ref ' + JSON.stringify(task.ref))
  git(['checkout', '-q', sha], dir)
  return { dir, baseSha: sha }
}

function applyVariant(dir: string, variant: HelixSolutionVariant): string {
  for (const [path, content] of Object.entries(variant.files ?? {})) {
    const target = join(dir, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return variant.answer ?? ''
}

let failures = 0
const seededRepos = seedAll(join(scratch, 'repos'), repoRoot)
const byId = new Map(seededRepos.map(r => [r.id, r]))

for (const task of HELIX_TASKS) {
  const seeded = byId.get(task.repo)
  if (!seeded) {
    failures += 1
    console.log('FAIL ' + task.id + ' — repo not seeded: ' + task.repo)
    continue
  }
  const problems: string[] = []

  // BEFORE — must reject.
  {
    const { dir, baseSha } = materialize(seeded, task, 'before')
    const verdict = gradeTask(task, dir, '', Date.now, { baseSha })
    if (verdict.accepted) problems.push('BEFORE state was accepted (task cannot fail-before-repair)')
    rmSync(dir, { recursive: true, force: true })
  }

  // REFERENCE — must accept (both uncommitted AND committed, the T10/T20
  // lesson: an agent that commits its work is graded on the work).
  {
    const { dir, baseSha } = materialize(seeded, task, 'reference')
    const answer = applyVariant(dir, task.reference)
    const verdict = gradeTask(task, dir, answer, Date.now, { baseSha })
    if (!verdict.accepted) {
      const detail = verdict.components
        .filter(c => !c.pass)
        .map(c => c.name + ': ' + c.detail)
        .join(' | ')
      problems.push('REFERENCE rejected — ' + detail)
    }
    rmSync(dir, { recursive: true, force: true })
  }
  if (task.reference.files && !task.grader.zeroDiff) {
    const { dir, baseSha } = materialize(seeded, task, 'reference-committed')
    const answer = applyVariant(dir, task.reference)
    git(['add', '-A'], dir)
    git(
      [
        '-c', 'user.name=agent', '-c', 'user.email=agent@local',
        'commit', '-q', '-m', 'apply the fix',
      ],
      dir,
    )
    const verdict = gradeTask(task, dir, answer, Date.now, { baseSha })
    if (!verdict.accepted) problems.push('COMMITTED reference rejected (the T10/T20 grader class)')
    rmSync(dir, { recursive: true, force: true })
  }

  // FALSIFY — every variant must reject.
  for (const variant of task.falsify) {
    const { dir, baseSha } = materialize(seeded, task, 'falsify-' + variant.name)
    const answer = applyVariant(dir, variant)
    const verdict = gradeTask(task, dir, answer, Date.now, { baseSha })
    if (verdict.accepted) problems.push('FALSIFY ' + variant.name + ' was ACCEPTED')
    rmSync(dir, { recursive: true, force: true })
  }

  if (problems.length === 0) {
    console.log('  ok  ' + task.id + ' (' + task.title + ')')
  } else {
    failures += 1
    for (const problem of problems) console.log('  FAIL ' + task.id + ' — ' + problem)
  }
}

rmSync(scratch, { recursive: true, force: true })
const seconds = Math.round((Date.now() - started) / 1000)
if (failures > 0) {
  console.error('prove-corpus-falsifiable: ' + failures + ' task(s) violated the law (' + seconds + 's)')
  process.exit(1)
}
console.log('prove-corpus-falsifiable: green — ' + HELIX_TASKS.length + ' tasks × before/reference/falsify (' + seconds + 's)')
