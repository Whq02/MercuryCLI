#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-manifest-finalize.ts — manifest finalisation.
//
//  What the code did vs the invariant it missed: WorkflowTool's inline write
//  chain latched `manifestFinalized = true` BEFORE the terminal write landed;
//  a write failure resolved false (which all five terminal callers ignored)
//  while the latch stayed true — so one transient publish failure left
//  run.json claiming 'running' after everything else settled, and every
//  later attempt returned true without executing.
//
//  The invariant: the finalized latch may only survive a LANDED terminal
//  snapshot; a failed terminal write retries once, and if both attempts fail
//  the latch resets so a later attempt is never swallowed. Ordering (writes
//  land in call order) and the straggling-heartbeat guard are preserved.
//
//  Seam: createManifestWriteChain (runManifest.ts — the same object
//  WorkflowTool.call() drives) with an injected publisher.
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'manifest-finalize-home-'))

const { createManifestWriteChain } = await import(
  '../../src/tools/WorkflowTool/runManifest.js'
)
import type { WorkflowRunManifest } from '../../src/tools/WorkflowTool/runManifest.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const snap = (status: WorkflowRunManifest['status']): WorkflowRunManifest =>
  ({
    version: 1,
    runId: 'wf_test',
    runDir: '/nowhere',
    startTime: 0,
    status,
    ownerPid: process.pid,
    agentCount: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    agents: [],
  }) as WorkflowRunManifest

type Rig = {
  chain: ReturnType<typeof createManifestWriteChain>
  published: WorkflowRunManifest[]
  attempts: number
  failNext: (n: number) => void
}
function makeRig(): Rig {
  const rig = {} as Rig
  rig.published = []
  rig.attempts = 0
  let failCount = 0
  rig.failNext = (n: number) => {
    failCount = n
  }
  rig.chain = createManifestWriteChain(
    async m => {
      rig.attempts++
      if (failCount > 0) {
        failCount--
        throw new Error('transient publish failure')
      }
      rig.published.push(m)
    },
    () => {},
  )
  return rig
}

section('§A a transient terminal failure retries once and still lands')
{
  const rig = makeRig()
  rig.failNext(1)
  const ok = await rig.chain.write(snap('failed'), true)
  check('terminal write reports landed (the bounded retry saved it)', ok === true)
  check('exactly two publish attempts (one retry, no runaway)', rig.attempts === 2, String(rig.attempts))
  check('the terminal snapshot is on disk-equivalent', rig.published.length === 1 && rig.published[0]!.status === 'failed')
  check('the latch holds after the landed final', rig.chain.finalized() === true)
  const swallowed = await rig.chain.write(snap('running'), false)
  check('a straggling heartbeat after the landed final is swallowed', swallowed === true && rig.attempts === 2)
}

section('§B both attempts failing UNLATCHES — a later attempt is never swallowed')
{
  const rig = makeRig()
  rig.failNext(2)
  const ok = await rig.chain.write(snap('completed'), true)
  check('the double-failed terminal write reports false', ok === false)
  check('two attempts were made', rig.attempts === 2, String(rig.attempts))
  check('the latch RESET on total failure (run.json is not zombie-finalized)', rig.chain.finalized() === false)
  const retry = await rig.chain.write(snap('completed'), true)
  check('a later terminal attempt executes and lands', retry === true && rig.published.some(m => m.status === 'completed'))
  check('the latch holds after the recovery', rig.chain.finalized() === true)
}

section('§C ordering + non-final semantics preserved')
{
  const rig = makeRig()
  // enqueue a slow-ish pre-terminal flush then immediately the terminal write
  const first = rig.chain.write(snap('running'), false)
  const second = rig.chain.write(snap('killed'), true)
  const [a, b] = await Promise.all([first, second])
  check('both writes landed', a === true && b === true)
  check(
    'writes land in CALL order (running before killed — the terminal snapshot is last)',
    rig.published.map(m => m.status).join(',') === 'running,killed',
    rig.published.map(m => m.status).join(','),
  )
}
{
  const rig = makeRig()
  rig.failNext(1)
  const ok = await rig.chain.write(snap('running'), false)
  check('a failed NON-final write does not retry (throttle re-stamps cover it)', ok === false && rig.attempts === 1)
  check('a failed non-final write never latches', rig.chain.finalized() === false)
  const next = await rig.chain.write(snap('running'), false)
  check('the next heartbeat lands normally', next === true && rig.published.length === 1)
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} MANIFEST-FINALIZE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL MANIFEST-FINALIZE PROOFS PASS')
