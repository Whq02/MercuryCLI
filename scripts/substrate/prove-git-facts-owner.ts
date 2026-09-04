#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

process.env.NODE_ENV = 'test'
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const SCRATCH = mkdtempSync(join(tmpdir(), 'git-facts-owner-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR)
const REPO = join(SCRATCH, 'repo')
const REMOTE = join(SCRATCH, 'remote.git')
const LANE = join(SCRATCH, 'lane-1')
const SHIM_DIR = join(SCRATCH, 'shim')
const SHIM_LOG = join(SCRATCH, 'git-shim.log')
const EMPTY_BIN = join(SCRATCH, 'empty-bin')
mkdirSync(SHIM_DIR)
mkdirSync(EMPTY_BIN)
writeFileSync(SHIM_LOG, '')
writeFileSync(
  join(SHIM_DIR, 'git'),
  ['#!/bin/bash', `printf '%s\\t%s\\n' "$(date +%s%N 2>/dev/null || echo 0)" "$*" >> "${SHIM_LOG}"`, `exec "${REAL_GIT}" "$@"`, ''].join('\n'),
)
chmodSync(join(SHIM_DIR, 'git'), 0o755)

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, ['-c', 'user.email=prover@example.invalid', '-c', 'user.name=prover', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

mkdirSync(REPO)
git(REPO, 'init', '-q', '-b', 'main')
writeFileSync(join(REPO, 'README.md'), 'owner proof\n')
git(REPO, 'add', '-A')
git(REPO, 'commit', '-qm', 'seed')
git(SCRATCH, 'init', '-q', '--bare', REMOTE)
git(REPO, 'remote', 'add', 'origin', REMOTE)
git(REPO, 'push', '-q', '-u', 'origin', 'main')
git(REPO, 'worktree', 'add', '-q', '-b', 'lane-1', LANE)

const REAL_PATH = process.env.PATH ?? ''
process.env.PATH = `${SHIM_DIR}:${REAL_PATH}`
process.chdir(REPO)

function shimRows(): string[] {
  return readFileSync(SHIM_LOG, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t')[1] ?? '')
}
function countShape(rows: string[], head: string): number {
  return rows.filter(r => r.startsWith(head)).length
}
let mark = 0
function since(): string[] {
  const rows = shimRows()
  return rows.slice(mark)
}
function resetMark(): void {
  mark = shimRows().length
}

const realNow = Date.now
let clockOffset = 0
Date.now = () => realNow() + clockOffset

const gitMod = await import('../../src/utils/git.js')
const fsMod = await import('../../src/utils/git/gitFilesystem.js')
const { getGitState, getGitWorktreeLanes, subscribeGitFacts, markGitTreeSuspect, gitProbeNote, _gitFactsForTesting } = gitMod

console.log('============================================================')
console.log(' the git-facts owner — once per change, never per beat')
console.log('============================================================')

console.log('\n§1 two concurrent readers ⇒ one spawn set, one snapshot')
{
  resetMark()
  const [a, b, c] = await Promise.all([getGitState(), getGitState(), getGitState()])
  const rows = since()
  check('three concurrent getGitState answer the live state', a !== null && a.branchName === 'main' && a.commitHash.length === 40, JSON.stringify(a))
  check('the readers share ONE snapshot object', a === b && b === c)
  check('one status probe for three readers', countShape(rows, 'status --porcelain') === 1, rows.join(' | '))
  check('one upstream probe (rev-list answers both upstream facts)', countShape(rows, 'rev-list --count @{upstream}..HEAD') === 1, rows.join(' | '))
  check('no rev-parse --verify @{upstream} (the second upstream process is gone)', countShape(rows, 'rev-parse --verify') === 0)
  check('no worktree list until a lane reader demands it', countShape(rows, 'worktree list') === 0)
  check('the facts read true: an upstream exists, nothing unpushed, clean', a !== null && a.isHeadOnRemote && a.unpushedCount === 0 && a.isClean)
}

console.log('\n§2 an idle reader spawns nothing')
{
  resetMark()
  const first = await getGitState()
  for (let i = 0; i < 5; i++) {
    await sleep(120)
    const again = await getGitState()
    if (again !== first) check('idle reads keep the snapshot identity', false, `read ${i} minted a new object`)
  }
  check('five idle reads over 600 ms spawn nothing', since().length === 0, since().join(' | '))
  check('the idle snapshot keeps its identity', (await getGitState()) === first)
}

console.log('\n§3 the index moves ⇒ exactly one status probe within 2 s, one notification')
{
  let notified = 0
  const unsub = subscribeGitFacts(() => {
    notified++
  })
  clockOffset += 61_000
  resetMark()
  writeFileSync(join(REPO, 'new.txt'), 'dirt\n')
  git(REPO, 'add', 'new.txt')
  const t0 = realNow()
  const seen = await waitUntil(() => notified >= 1, 2_000)
  const elapsed = realNow() - t0
  await sleep(300)
  const rows = since()
  check('the owner recomputed and notified within 2 s', seen, `${elapsed} ms`)
  check('exactly one status probe', countShape(rows, 'status --porcelain') === 1, rows.join(' | '))
  check('no upstream probe for an index move', countShape(rows, 'rev-list') === 0, rows.join(' | '))
  check('exactly one notification', notified === 1, String(notified))
  const state = await getGitState()
  check('the snapshot now reads dirty', state !== null && !state.isClean)
  unsub()
}

console.log('\n§4 the floor: a signal inside the window dirties and arms the trailing recompute')
{
  let notified = 0
  const unsub = subscribeGitFacts(() => {
    notified++
  })
  clockOffset += 61_000
  markGitTreeSuspect('git')
  await sleep(900)
  const opened = _gitFactsForTesting()
  check('a signal outside the window recomputed at once and opened a new window', !opened.entries.upstream.dirty && opened.entries.upstream.notBefore > Date.now(), JSON.stringify(opened.entries.upstream))
  resetMark()
  git(REPO, 'commit', '-qm', 'inside the window')
  await sleep(400)
  await sleep(400)
  const facts = _gitFactsForTesting()
  check('the upstream entry is dirty and deferred (inside its floor)', facts.entries.upstream.dirty && facts.entries.upstream.notBefore > Date.now(), JSON.stringify(facts.entries.upstream))
  check('the trailing recompute is armed', facts.trailingArmed)
  check('no upstream probe spawned inside the window', countShape(since(), 'rev-list') === 0, since().join(' | '))
  const state = await getGitState()
  const head = git(REPO, 'rev-parse', 'HEAD')
  check('the filesystem facts moved at once (HEAD)', state !== null && state.commitHash === head)
  check('the deferred upstream count still reads the last value (0)', state !== null && state.unpushedCount === 0)
  clockOffset += 61_000
  resetMark()
  const after = await getGitState()
  check('a demand outside the window recomputes: one unpushed commit', after !== null && after.unpushedCount === 1, JSON.stringify(after))
  check('exactly one upstream probe for the demand', countShape(since(), 'rev-list') === 1, since().join(' | '))
  unsub()
  void notified
}

console.log('\n§5 the seams poke the owner: a Bash git word, a mutation, a turn end')
{
  const vs = await import('../../src/utils/verification/verificationState.js')
  const { processMainOwner } = await import('../../src/services/run/resolveOwner.js')
  clockOffset += 61_000
  await getGitState()
  let before = _gitFactsForTesting()
  vs.observeCompletedToolCall('Bash', { command: 'git commit -m "x"' }, true, REPO, processMainOwner())
  let facts = _gitFactsForTesting()
  check('a Bash git command dirties every spawned fact', facts.entries.upstream.dirty && facts.entries.clean.dirty && facts.entries.lanes.dirty, JSON.stringify(facts.entries))
  clockOffset += 61_000
  await getGitState()
  before = _gitFactsForTesting()
  check('a demand outside the window cleared the flags', !before.entries.upstream.dirty && !before.entries.clean.dirty)
  vs.markMutation(processMainOwner(), [join(REPO, 'README.md')], REPO)
  facts = _gitFactsForTesting()
  check('an Edit/Write mutation dirties the clean verdict only', facts.entries.clean.dirty && !facts.entries.upstream.dirty, JSON.stringify(facts.entries))
  clockOffset += 61_000
  await getGitState()
  vs.markTreeSuspectAfterTurn()
  facts = _gitFactsForTesting()
  check('a turn end dirties the clean verdict', facts.entries.clean.dirty)
  const vsSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'verification', 'verificationState.ts'), 'utf8')
  check('markMutation pokes the owner (source)', /markGitTreeSuspect\('tree'\)/.test(vsSrc.slice(vsSrc.indexOf('export function markMutation('), vsSrc.indexOf('export function verifyEvidenceEnabled'))))
  check('markTreeSuspectAfterTurn pokes the owner (source)', /markGitTreeSuspect\('tree'\)/.test(vsSrc.slice(vsSrc.indexOf('export function markTreeSuspectAfterTurn'), vsSrc.indexOf('export function computeWorkingTreeDigest('))))
}

console.log('\n§6 a faulting git speaks once and backs off 4×; a working git recovers')
{
  clockOffset += 61_000
  await getGitState()
  const unsub = subscribeGitFacts(() => {})
  process.env.PATH = EMPTY_BIN
  ;(gitMod.gitExe as unknown as { cache: { clear(): void } }).cache.clear()
  resetMark()
  const beforeState = await getGitState()
  clockOffset += 61_000
  markGitTreeSuspect('git')
  await sleep(900)
  const facts = _gitFactsForTesting()
  check('every spawned fact faulted once', facts.entries.upstream.failures === 1 && facts.entries.clean.failures === 1, JSON.stringify(facts.entries))
  check('the faulting entry backed off 4× the floor', facts.entries.clean.notBefore - facts.entries.clean.computedAt === 240_000, String(facts.entries.clean.notBefore - facts.entries.clean.computedAt))
  check('ONE notice speaks', facts.notice !== null && facts.notice.includes('probe failed') && gitProbeNote() === facts.notice, String(facts.notice))
  const during = await getGitState()
  check('the last good values stand while git is gone', during !== null && beforeState !== null && during.unpushedCount === beforeState.unpushedCount && during.isClean === beforeState.isClean)
  markGitTreeSuspect('git')
  await sleep(900)
  const again = _gitFactsForTesting()
  check('a second signal inside the back-off spawns no retry (failures stay 1)', again.entries.clean.failures === 1 && again.entries.upstream.failures === 1, JSON.stringify(again.entries))
  check('the notice is still the one line', again.notice === facts.notice)
  process.env.PATH = `${SHIM_DIR}:${REAL_PATH}`
  ;(gitMod.gitExe as unknown as { cache: { clear(): void } }).cache.clear()
  clockOffset += 241_000
  resetMark()
  const recovered = await getGitState()
  const post = _gitFactsForTesting()
  check('a working git recovers on the next demand outside the back-off', recovered !== null && post.entries.clean.failures === 0 && post.entries.upstream.failures === 0, JSON.stringify(post.entries))
  check('the recovery spawned one probe per fact', countShape(since(), 'status --porcelain') === 1 && countShape(since(), 'rev-list') === 1, since().join(' | '))
  unsub()
}

console.log('\n§7 the lane list: one worktree list per change')
{
  clockOffset += 61_000
  resetMark()
  const lanes = await getGitWorktreeLanes()
  check('the lane list reads the linked worktree', Array.isArray(lanes) && lanes.some(w => !w.isMain && w.branch === 'lane-1'), JSON.stringify(lanes))
  check('one worktree list process', countShape(since(), 'worktree list --porcelain') === 1, since().join(' | '))
  const againLanes = await getGitWorktreeLanes()
  check('a second read spawns nothing and keeps the value', againLanes === lanes && countShape(since(), 'worktree list --porcelain') === 1)
  let notified = 0
  const unsub = subscribeGitFacts(() => {
    notified++
  })
  clockOffset += 61_000
  resetMark()
  git(REPO, 'worktree', 'add', '-q', '-b', 'lane-2', join(SCRATCH, 'lane-2'))
  const seen = await waitUntil(() => countShape(since(), 'worktree list --porcelain') >= 1, 2_000)
  await sleep(300)
  check('the worktrees dir signal recomputed the list within 2 s', seen)
  check('exactly one worktree list process for the signal', countShape(since(), 'worktree list --porcelain') === 1, since().join(' | '))
  const updated = await getGitWorktreeLanes()
  check('the list now carries the new lane', Array.isArray(updated) && updated.some(w => w.branch === 'lane-2'))
  unsub()
  void notified
}

console.log('\n§8 a reground drops every entry; the next read recomputes')
{
  fsMod.regroundGitWatch()
  const facts = _gitFactsForTesting()
  check('every entry is empty after the reground', !facts.entries.upstream.hasValue && !facts.entries.clean.hasValue && !facts.entries.lanes.hasValue, JSON.stringify(facts.entries))
  resetMark()
  const state = await getGitState()
  check('the next read recomputes (one spawn set)', state !== null && countShape(since(), 'status --porcelain') === 1 && countShape(since(), 'rev-list') === 1, since().join(' | '))
}

console.log('\n§9 the source pins')
{
  const src = (p: string): string => readFileSync(join(import.meta.dir, '..', '..', p), 'utf8')
  const bus = src('src/state/telemetryBus.ts')
  check('the telemetry bus keys no memo on the digest (the owner replaces it)', !bus.includes('gitStateMemo') && !bus.includes('computeWorkingTreeDigest'))
  check('the telemetry bus subscribes to the owner', bus.includes('subscribeGitFacts(() => pokeTelemetry())'))
  const wb = src('src/services/workbench/projection.ts')
  check('heartbeats never chain: the workbench no longer rides the telemetry beat', !wb.includes('subscribeTelemetry('))
  check('the workbench subscribes to the owner and reads the lane list through it', wb.includes('subscribeGitFacts(') && wb.includes('getGitWorktreeLanes()') && !wb.includes('worktreeLanesMemo'))
  check('nothing on the gather path is a sync spawn (no sync observer import)', !/from '\.\.\/gitGraph\/observe\.js'/.test(wb) && !wb.includes('execFileSync'))
  const gitSrc = src('src/utils/git.ts')
  check('the owner consumes the git dir signal', gitSrc.includes('subscribeGitChanges(onGitSignal)'))
  check('the owner names its floor and back-off', gitSrc.includes('const PROBE_FLOOR_MS = 60_000') && gitSrc.includes('const PROBE_BACKOFF_FACTOR = 4'))
  const fsSrc = src('src/utils/git/gitFilesystem.ts')
  check('the pollers cover the index, packed refs and the worktrees dir', fsSrc.includes("join(gitDir, 'index')") && fsSrc.includes("join(commonDir, 'packed-refs')") && fsSrc.includes("join(commonDir, 'worktrees')"))
  check('the upstream ref is watched beside the branch ref', fsSrc.includes("signalChange('upstream-ref')"))
  const obs = src('src/services/gitGraph/observe.ts')
  check('the observer carries the async twin family', ['export function gitAsync(', 'export async function gitStatusAsync(', 'export async function gitWorktreesAsync(', 'export async function isGitRepoAsync('].every(s => obs.includes(s)))
  const snap = src('src/services/projectIntel/snapshot.ts')
  check('the drain road builds its git facts through the async twin', snap.includes('await gitFactsAsync(workspace)') && snap.includes('await buildSnapshotWithDigestAsync('))
  const doctor = src('src/utils/healthReport.ts')
  check('the doctor demands a fresh read and prints the one notice', doctor.includes('gitSnapshot({ fresh: true })') && doctor.includes('gitProbeNote()'))
  const feedback = src('src/components/Feedback.tsx')
  check('the feedback dialog reads the same snapshot', feedback.includes('await getGitState()') && !feedback.includes('hasUnpushedCommits'))
}

Date.now = realNow
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ THE GIT-FACTS OWNER SPAWNS ONCE PER CHANGE')
process.exit(0)
