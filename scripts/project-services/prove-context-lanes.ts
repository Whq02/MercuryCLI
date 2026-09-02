#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-context-lanes.ts — bounded side
// lanes, proved against the PRODUCTION lane store, boundary attachment,
//  handoff minting (observed changedPaths from real receipts), exactly-once
//  promotion, and the API text mapping.
//
//  Laws:
//    L. store — create/read/list/child-lookup round-trip (durable records)
//    B. boundary — the per-turn attachment exists ONLY for an active lane
//       child (null on ordinary sessions · null after return · null when
//       gated off); the text names the goal, the exclusions, and the
//       return verb; normalizeAttachmentForAPI wraps it as a system
//       reminder (so EVERY request re-asserts it — compaction-proof)
//    R. return — the handoff's changedPaths are the CHILD's observed
//       receipts, never prose; the record flips to returned
//    P. promote — exactly once: the first promote yields the handoff text,
//       the second answers already-promoted; the text carries the answer +
//       observed paths + the lane ref
//    D. drop — flips status only; the child transcript file is untouched
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-context-lanes.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'vanguard-lanes-'))
delete process.env.MERCURY_LANES
delete process.env.MERCURY_CHANGE_RECEIPTS

const {
  boundaryText,
  createLane,
  dropLane,
  laneBoundaryAttachmentFor,
  laneForChildSession,
  listLanes,
  promoteHandoff,
  readLane,
  returnLane,
} = await import('../../src/services/contextLanes/lanes.ts')
const { observeToolTerminal } = await import('../../src/services/run/effectObserver.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { _resetChangeReceiptsForTesting } = await import(
  '../../src/services/changeTransaction/receipts.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — context lanes proof exceeded 60s')
  process.exit(1)
}, 60_000)
guard.unref?.()

const PARENT = 'parent-session-0001'
const CHILD = 'child-session-0002'

// ── L. store ────────────────────────────────────────────────────────────────
section('L. the durable lane store')
const lane = createLane({
  parentSessionId: PARENT,
  childSessionId: CHILD,
  goal: 'check whether the cache TTL heuristic still holds under 1h sessions',
  selectedContextRefs: ['mercury://run/current'],
})
{
  check('L1 create/read round-trip',
    readLane(lane.id)?.goal.includes('cache TTL') === true)
  check('L2 parent listing finds it', listLanes({ parentSessionId: PARENT }).length === 1)
  check('L3 the child-session lookup resolves the ACTIVE lane',
    laneForChildSession(CHILD)?.id === lane.id)
  check('L4 an unrelated session has no lane', laneForChildSession('other') === null)
}

// ── B. boundary ─────────────────────────────────────────────────────────────
section('B. the per-turn boundary attachment')
{
  const a = laneBoundaryAttachmentFor(CHILD)
  check('B1 the child session gets the boundary attachment',
    a?.type === 'lane_boundary' && a.laneId === lane.id)
  check('B2 the boundary names goal + exclusions + the return verb',
    (a?.boundary.includes('cache TTL') ?? false) &&
    (a?.boundary.includes('EXCLUDED') ?? false) &&
    (a?.boundary.includes('pending task list') ?? false) &&
    (a?.boundary.includes('/branch return') ?? false))
  check('B3 an ordinary session gets nothing', laneBoundaryAttachmentFor(PARENT) === null)

  process.env.MERCURY_LANES = '0'
  check('B4 gate OFF ⇒ no boundary', laneBoundaryAttachmentFor(CHILD) === null)
  delete process.env.MERCURY_LANES

  const { normalizeAttachmentForAPI } = await import(
    '../../src/utils/messages/attachmentText.ts'
  )
  const messages = normalizeAttachmentForAPI(a as never)
  const text = JSON.stringify(messages)
  check('B5 the API mapping wraps the boundary as a system reminder (re-asserted every request)',
    Array.isArray(messages) && messages.length === 1 &&
    text.includes('system-reminder') && text.includes('BOUNDED SIDE LANE'))
  check('B6 the boundary text is deterministic', boundaryText(lane) === (a?.boundary ?? ''))
}

// ── R. return ───────────────────────────────────────────────────────────────
section('R. the typed handoff on return')
{
  _resetChangeReceiptsForTesting()
  // The CHILD's observed work: receipts on this process's main-lane owner
  // (the same owner returnLane reads).
  const owner = processOwnerForLane(null)
  for (const p of ['/tmp/lane-a.ts', '/tmp/lane-b.ts']) {
    observeToolTerminal({
      owner,
      toolName: 'Edit',
      toolUseId: 'toolu_lane',
      input: { file_path: p },
      ok: true,
      durationMs: 1,
      cwd: '/tmp',
      effect: {
        outcome: 'succeeded',
        operation: 'file.edit',
        changedPaths: [p],
        evidence: 'lane work',
        startedAt: 1,
        completedAt: 2,
      },
    } as never)
  }
  const returned = returnLane({
    lane,
    answer: 'the heuristic holds; I also changed /tmp/prose-claim.ts (a lie)',
    findings: ['TTL flips only at cold boundaries'],
    unresolved: ['the 5m fallback path is untested'],
  })
  check('R1 the record flips to returned with the handoff',
    returned.status === 'returned' && returned.handoff?.answer.includes('holds') === true)
  check('R2 changedPaths are the OBSERVED receipts (prose claims mint nothing)',
    returned.handoff?.changedPaths.length === 2 &&
    returned.handoff.changedPaths.includes('/tmp/lane-a.ts') &&
    !returned.handoff.changedPaths.includes('/tmp/prose-claim.ts'))
  check('R3 a returned lane no longer produces the boundary',
    laneBoundaryAttachmentFor(CHILD) === null)
}

// ── P. promote exactly-once ─────────────────────────────────────────────────
section('P. exactly-once promotion')
{
  const first = promoteHandoff(lane.id)
  check('P1 the first promote yields the handoff text',
    'handoffText' in first &&
    first.handoffText.includes('<lane-handoff') &&
    first.handoffText.includes('/tmp/lane-a.ts') &&
    first.handoffText.includes(`mercury://lane/${lane.id}`))
  const second = promoteHandoff(lane.id)
  check('P2 the second promote answers already-promoted (no re-injection)',
    'alreadyPromoted' in second)
  const missing = promoteHandoff('lane-nonexistent')
  check('P3 an unknown lane errors honestly', 'error' in missing)
  const unreturned = createLane({ parentSessionId: PARENT, childSessionId: 'c3', goal: 'g' })
  const early = promoteHandoff(unreturned.id)
  check('P4 promoting an unreturned lane refuses with its status',
    'error' in early && early.error.includes('active'))
}

// ── D. drop ─────────────────────────────────────────────────────────────────
section('D. drop never destroys work')
{
  const transcript = join(mkdtempSync(join(tmpdir(), 'lane-transcript-')), 'child.jsonl')
  writeFileSync(transcript, '{"type":"user"}\n')
  const l2 = createLane({ parentSessionId: PARENT, childSessionId: 'c4', goal: 'g2' })
  const dropped = dropLane(l2.id)
  check('D1 drop flips the status', dropped?.status === 'dropped')
  check('D2 files are untouched', existsSync(transcript))
  check('D3 the record survives for the resource plane (mercury://lane)',
    readLane(l2.id)?.status === 'dropped')
}

// ── A. the resource adapter ─────────────────────────────────────────────────
section('A. mercury://lane addressing')
{
  await import('../../src/services/resources/adapters/lane.ts')
  const { resolveResource } = await import('../../src/services/resources/registry.ts')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
  const owner = makeOwnerKey({ workspace: '/tmp', sessionId: PARENT, lane: 'main' } as never)
  const one = await resolveResource(`mercury://lane/${lane.id}`, { owner, cwd: '/tmp' } as never)
  check('A1 a lane resolves with goal + handoff + promotion state',
    one.state === 'ok' &&
    one.resource.text?.includes('cache TTL') === true &&
    one.resource.text.includes('promoted'))
  const gone = await resolveResource('mercury://lane/lane-none', { owner, cwd: '/tmp' } as never)
  check('A2 an unknown lane is ABSENT', gone.state === 'absent')
}

// ── M. the per-round lookup memo (FN-014 row 1) ─────────────────────────────
// laneForChildSession rides EVERY tool round of EVERY session; the memo
// keys on the lanes dir's mtime so a foreign PROCESS's atomic lane publish
// (a rename — it always moves the dir mtime) is seen next round, while an
// unmoved dir costs one stat and zero reads.
section('M. the per-round lookup memo')
{
  const { statSync, writeFileSync, renameSync, readFileSync: rfs } = await import('node:fs')
  const { join: j } = await import('node:path')
  const lanesDir = j(String(process.env.MERCURY_CONFIG_DIR), 'lanes')
  // Prime the memo for CHILD (whatever earlier sections left, this read memoizes).
  const primed = laneForChildSession(CHILD)
  check('M1 the primed lookup answers the standing truth', primed !== null)
  // An IN-PLACE content rewrite moves no dir mtime — the memo must HOLD
  // (this is the memo's honest grain: one stat, no reads, per round).
  const laneFile = j(lanesDir, `${lane.id}.json`)
  const original = rfs(laneFile, 'utf8')
  writeFileSync(laneFile, original.replace(/"status": "\w+"/, '"status": "dropped"'))
  check('M2 an unmoved dir mtime serves the memo (no re-read — the round-cost law)',
    laneForChildSession(CHILD)?.status === primed?.status && primed?.status !== 'dropped')
  // A RENAME into the dir (every atomic publish's shape, any process) moves
  // the mtime — the next lookup rescans and sees the dropped status.
  const before = statSync(lanesDir).mtimeMs
  writeFileSync(j(lanesDir, '.tmp-foreign'), '{}')
  renameSync(j(lanesDir, '.tmp-foreign'), j(lanesDir, 'foreign-marker.json'))
  const moved = statSync(lanesDir).mtimeMs !== before
  check('M3 a foreign-process publish shape moves the dir mtime', moved)
  check('M4 the moved dir invalidates the memo (cross-process freshness)',
    laneForChildSession(CHILD)?.status === 'dropped')
  // Restore for any later section: same-process writeLane invalidates directly.
  writeFileSync(laneFile, original)
  const src = rfs(j(import.meta.dir, '..', '..', 'src', 'services', 'contextLanes', 'lanes.ts'), 'utf8')
  check('M5 writeLane invalidates the memo in-process (the self-heal shape)',
    /laneScanMemo = null/.test(src) && src.includes('function writeLane(') && src.indexOf('laneScanMemo = null') > src.indexOf('function writeLane('))
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ context lanes: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ context lanes: every law holds')
