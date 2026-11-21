#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitSubcommandArgv } from '../lib/git.ts'

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

const ownerFix = 'fix the git facts owner in src/utils/git.ts (getGitState, markGitTreeSuspect, _gitFactsForTesting)'
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
function plainShape(row: string): string {
  return gitSubcommandArgv(row.split(' ')).join(' ')
}
function countShape(rows: string[], head: string): number {
  return rows.filter(r => plainShape(r).startsWith(head)).length
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
  check('three concurrent getGitState answer the live state', a !== null && a.branchName === 'main' && a.commitHash.length === 40, `${JSON.stringify(a)} — ${ownerFix}`)
  check('the readers share ONE snapshot object', a === b && b === c, `${ownerFix}; concurrent getGitState calls must share one in-flight read`)
  check('one status probe for three readers', countShape(rows, 'status --porcelain') === 1, `${rows.join(' | ')} — ${ownerFix}`)
  check('one upstream probe (rev-list answers both upstream facts)', countShape(rows, 'rev-list --count @{upstream}..HEAD') === 1, `${rows.join(' | ')} — ${ownerFix}`)
  check('no rev-parse --verify @{upstream} (the second upstream process is gone)', countShape(rows, 'rev-parse --verify') === 0, `${rows.join(' | ')} — ${ownerFix}`)
  check('no worktree list until a lane reader demands it', countShape(rows, 'worktree list') === 0, `${rows.join(' | ')} — ${ownerFix}; getGitState must not list worktrees`)
  check('the facts read true: an upstream exists, nothing unpushed, clean', a !== null && a.isHeadOnRemote && a.unpushedCount === 0 && a.isClean, `${JSON.stringify(a)} — ${ownerFix}`)
}

console.log('\n§2 an idle reader spawns nothing')
{
  resetMark()
  const first = await getGitState()
  for (let i = 0; i < 5; i++) {
    await sleep(120)
    const again = await getGitState()
    if (again !== first) check('idle reads keep the snapshot identity', false, `read ${i} minted a new object — ${ownerFix}`)
  }
  check('five idle reads over 600 ms spawn nothing', since().length === 0, `${since().join(' | ')} — ${ownerFix}; an idle getGitState must serve the cached snapshot`)
  check('the idle snapshot keeps its identity', (await getGitState()) === first, `${ownerFix}; an idle getGitState must return the same snapshot object`)
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
  check('the owner recomputed and notified within 2 s', seen, `${elapsed} ms — ${ownerFix}; an index change under .git must reach subscribeGitFacts listeners (watch in src/utils/git/gitFilesystem.ts)`)
  check('exactly one status probe', countShape(rows, 'status --porcelain') === 1, `${rows.join(' | ')} — ${ownerFix}`)
  check('no upstream probe for an index move', countShape(rows, 'rev-list') === 0, `${rows.join(' | ')} — ${ownerFix}`)
  check('exactly one notification', notified === 1, `${notified} — ${ownerFix}`)
  const state = await getGitState()
  check('the snapshot now reads dirty', state !== null && !state.isClean, `${ownerFix}; the clean verdict must be recomputed after an index change`)
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
  check('a signal outside the window recomputed at once and opened a new window', !opened.entries.upstream.dirty && opened.entries.upstream.notBefore > Date.now(), `${JSON.stringify(opened.entries.upstream)} — ${ownerFix}`)
  resetMark()
  git(REPO, 'commit', '-qm', 'inside the window')
  await sleep(400)
  await sleep(400)
  const facts = _gitFactsForTesting()
  check('the upstream entry is dirty and deferred (inside its floor)', facts.entries.upstream.dirty && facts.entries.upstream.notBefore > Date.now(), `${JSON.stringify(facts.entries.upstream)} — ${ownerFix}`)
  check('the trailing recompute is armed', facts.trailingArmed, `${ownerFix}; a signal inside the floor must arm the trailing recompute`)
  check('no upstream probe spawned inside the window', countShape(since(), 'rev-list') === 0, `${since().join(' | ')} — ${ownerFix}`)
  const state = await getGitState()
  const head = git(REPO, 'rev-parse', 'HEAD')
  check('the filesystem facts moved at once (HEAD)', state !== null && state.commitHash === head, `${ownerFix}; HEAD must be read from the filesystem facts, not deferred`)
  check('the deferred upstream count still reads the last value (0)', state !== null && state.unpushedCount === 0, `${ownerFix}; inside the floor getGitState must keep the last upstream value`)
  clockOffset += 61_000
  resetMark()
  const after = await getGitState()
  check('a demand outside the window recomputes: one unpushed commit', after !== null && after.unpushedCount === 1, `${JSON.stringify(after)} — ${ownerFix}`)
  check('exactly one upstream probe for the demand', countShape(since(), 'rev-list') === 1, `${since().join(' | ')} — ${ownerFix}`)
  unsub()
  void notified
}

console.log('\n§5 the seams poke the owner: a Bash git word, a mutation, a turn end')
{
  const vs = await import('../../src/utils/verification/verificationState.js')
  const { processMainOwner } = await import('../../src/utils/run/resolveOwner.js')
  clockOffset += 61_000
  await getGitState()
  let before = _gitFactsForTesting()
  vs.observeCompletedToolCall('Bash', { command: 'git commit -m "x"' }, true, REPO, processMainOwner())
  let facts = _gitFactsForTesting()
  check('a Bash git command dirties every spawned fact', facts.entries.upstream.dirty && facts.entries.clean.dirty && facts.entries.lanes.dirty, `${JSON.stringify(facts.entries)} — observeCompletedToolCall in src/utils/verification/verificationState.ts must call markGitTreeSuspect for a Bash git command`)
  clockOffset += 61_000
  await getGitState()
  before = _gitFactsForTesting()
  check('a demand outside the window cleared the flags', !before.entries.upstream.dirty && !before.entries.clean.dirty, `${JSON.stringify(before.entries)} — ${ownerFix}`)
  vs.markMutation(processMainOwner(), [join(REPO, 'README.md')], REPO)
  facts = _gitFactsForTesting()
  check('an Edit/Write mutation dirties the clean verdict only', facts.entries.clean.dirty && !facts.entries.upstream.dirty, `${JSON.stringify(facts.entries)} — markMutation in src/utils/verification/verificationState.ts must dirty only the clean verdict`)
  clockOffset += 61_000
  await getGitState()
  vs.markTreeSuspectAfterTurn()
  facts = _gitFactsForTesting()
  check('a turn end dirties the clean verdict', facts.entries.clean.dirty, `${JSON.stringify(facts.entries)} — markTreeSuspectAfterTurn in src/utils/verification/verificationState.ts must dirty the clean verdict`)
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
  check('every spawned fact faulted once', facts.entries.upstream.failures === 1 && facts.entries.clean.failures === 1, `${JSON.stringify(facts.entries)} — ${ownerFix}`)
  check('the faulting entry backed off 4× the floor', facts.entries.clean.notBefore - facts.entries.clean.computedAt === 240_000, `${facts.entries.clean.notBefore - facts.entries.clean.computedAt} — ${ownerFix}; a failed probe must set notBefore to 4 times the floor`)
  check('ONE notice speaks', facts.notice !== null && facts.notice.includes('probe failed') && gitProbeNote() === facts.notice, `${String(facts.notice)} — ${ownerFix}; gitProbeNote must return the single probe failed notice`)
  const during = await getGitState()
  check('the last good values stand while git is gone', during !== null && beforeState !== null && during.unpushedCount === beforeState.unpushedCount && during.isClean === beforeState.isClean, `${ownerFix}; a faulting git must leave the last good values in place`)
  markGitTreeSuspect('git')
  await sleep(900)
  const again = _gitFactsForTesting()
  check('a second signal inside the back-off spawns no retry (failures stay 1)', again.entries.clean.failures === 1 && again.entries.upstream.failures === 1, `${JSON.stringify(again.entries)} — ${ownerFix}; a signal inside the back-off must not retry`)
  check('the notice is still the one line', again.notice === facts.notice, `${String(again.notice)} — ${ownerFix}`)
  process.env.PATH = `${SHIM_DIR}:${REAL_PATH}`
  ;(gitMod.gitExe as unknown as { cache: { clear(): void } }).cache.clear()
  clockOffset += 241_000
  resetMark()
  const recovered = await getGitState()
  const post = _gitFactsForTesting()
  check('a working git recovers on the next demand outside the back-off', recovered !== null && post.entries.clean.failures === 0 && post.entries.upstream.failures === 0, `${JSON.stringify(post.entries)} — ${ownerFix}; a successful probe must reset failures`)
  check('the recovery spawned one probe per fact', countShape(since(), 'status --porcelain') === 1 && countShape(since(), 'rev-list') === 1, `${since().join(' | ')} — ${ownerFix}`)
  unsub()
}

console.log('\n§7 the lane list: one worktree list per change')
{
  clockOffset += 61_000
  resetMark()
  const lanes = await getGitWorktreeLanes()
  check('the lane list reads the linked worktree', Array.isArray(lanes) && lanes.some(w => !w.isMain && w.branch === 'lane-1'), `${JSON.stringify(lanes)} — fix getGitWorktreeLanes in src/utils/git.ts`)
  check('one worktree list process', countShape(since(), 'worktree list --porcelain') === 1, `${since().join(' | ')} — fix getGitWorktreeLanes in src/utils/git.ts`)
  const againLanes = await getGitWorktreeLanes()
  check('a second read spawns nothing and keeps the value', againLanes === lanes && countShape(since(), 'worktree list --porcelain') === 1, `${since().join(' | ')} — getGitWorktreeLanes in src/utils/git.ts must serve the cached lane list`)
  let notified = 0
  const unsub = subscribeGitFacts(() => {
    notified++
  })
  clockOffset += 61_000
  resetMark()
  git(REPO, 'worktree', 'add', '-q', '-b', 'lane-2', join(SCRATCH, 'lane-2'))
  const seen = await waitUntil(() => countShape(since(), 'worktree list --porcelain') >= 1, 2_000)
  await sleep(300)
  check('the worktrees dir signal recomputed the list within 2 s', seen, `${ownerFix}; a change under the worktrees dir must dirty the lanes fact (watch in src/utils/git/gitFilesystem.ts)`)
  check('exactly one worktree list process for the signal', countShape(since(), 'worktree list --porcelain') === 1, `${since().join(' | ')} — ${ownerFix}`)
  const updated = await getGitWorktreeLanes()
  check('the list now carries the new lane', Array.isArray(updated) && updated.some(w => w.branch === 'lane-2'), `${JSON.stringify(updated)} — fix getGitWorktreeLanes in src/utils/git.ts`)
  unsub()
  void notified
}

console.log('\n§8 a reground drops every entry; the next read recomputes')
{
  fsMod.regroundGitWatch()
  const facts = _gitFactsForTesting()
  check('every entry is empty after the reground', !facts.entries.upstream.hasValue && !facts.entries.clean.hasValue && !facts.entries.lanes.hasValue, `${JSON.stringify(facts.entries)} — regroundGitWatch in src/utils/git/gitFilesystem.ts must drop every owner entry`)
  resetMark()
  const state = await getGitState()
  check('the next read recomputes (one spawn set)', state !== null && countShape(since(), 'status --porcelain') === 1 && countShape(since(), 'rev-list') === 1, `${since().join(' | ')} — ${ownerFix}`)
}

console.log('\n§9 the source pins')
{
  const { healthContext } = await import('../../src/services/health/healthReport.ts')
  const { gitChecks } = await import('../../src/services/health/sections/git.ts')
  const { gitProbeNote: noteNow } = await import('../../src/utils/git.ts')
  await getGitState()
  resetMark()
  await getGitState()
  const warmSpawns = countShape(since(), 'status --porcelain')
  resetMark()
  const gitContext = await healthContext()
  const freshSpawns = countShape(since(), 'status --porcelain')
  check('/health asks for its git facts fresh: with the facts warm a plain read spawns no status and the report context spawns one', warmSpawns === 0 && freshSpawns === 1, `warm ${warmSpawns} · fresh ${freshSpawns} — healthContext in src/services/health/healthReport.ts must read git facts fresh and a plain getGitState must not`)
  const gitSays = await gitChecks(gitContext).find(row => row.id === 'git')?.run()
  const probeNote = noteNow()
  check('/health demands a fresh read and prints the one notice', gitSays !== undefined && (gitContext.repo === null ? gitSays.status === 'info' || gitSays.status === 'unknown' : probeNote !== null ? gitSays.status === 'warn' && gitSays.evidence.endsWith(` · ${probeNote}`) : gitSays.status === 'ok' && gitSays.evidence.endsWith(' (getGitState)') && gitSays.evidence.includes(gitContext.repo.commitHash.slice(0, 7))), `${gitSays?.evidence} — fix the git row in src/services/health/sections/git.ts`)
}

Date.now = realNow
console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ ${failures} CHECK(S) FAILED`)
  process.exit(1)
}
console.log('✅ THE GIT-FACTS OWNER SPAWNS ONCE PER CHANGE')
process.exit(0)
