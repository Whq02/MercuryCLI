#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-progress-projection.ts — ephemeral progress stays out
//  of the transcript (QUICKSTEP finding 1, + the F2 rider).
//
//  What the code did vs the invariant it missed: ephemeral tool ticks
//  (bash/powershell/mcp progress) rode the transcript `messages` array with
//  replace-last semantics. A progress message is NEVER a rendered row (the
//  pipeline's first filter drops it), never in the API view and never
//  persisted — it existed there purely to feed two lookup maps. Every 1s
//  tick minted a new array identity, re-ran the whole normalize→…→lookups
//  pipeline (29–42ms at 27k messages) and re-rendered every mounted row —
//  zero of 2.1M row comparisons reused identity in the audit — to change
//  nothing on screen. And executeQueuedInput closed over `messages`, waking
//  the queue processor once per message event for a guaranteed early return.
//
//  The invariant: an ephemeral tick re-renders exactly the one row whose
//  tool ticked (a keyed external store beside the transcript — the
//  streamingTail shape); the transcript array never sees ephemeral frames;
//  non-ephemeral progress trails still accumulate; the queued-input callback
//  reads the transcript at dispatch time from the store.
// ============================================================================
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'progress-projection-home-'))
process.env.MERCURY_CONFIG_DIR = HOME

const {
  publishEphemeralProgress,
  clearEphemeralProgress,
  getEphemeralProgressFrame,
  subscribeEphemeralProgress,
  _resetEphemeralProgressForTesting,
} = await import('../../src/state/ephemeralProgressStore.js')
const { isEphemeralToolProgress } = await import('../../src/utils/sessionStorage/paths.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const tick = (toolUseID: string, n: number): never =>
  ({
    type: 'progress',
    parentToolUseID: toolUseID,
    toolUseID: `progress_${toolUseID}_${n}`,
    data: { type: 'bash_progress', elapsedTimeSeconds: n, totalLines: n * 3 },
  }) as never

section('§A the keyed store: replace semantics, per-key wakeups, reset law')
{
  _resetEphemeralProgressForTesting()
  let wakesA = 0
  let wakesB = 0
  const unsubA = subscribeEphemeralProgress('toolA', () => wakesA++)
  const unsubB = subscribeEphemeralProgress('toolB', () => wakesB++)

  for (let i = 1; i <= 60; i++) publishEphemeralProgress(tick('toolA', i))
  check('60 ticks hold ONE frame (replace semantics, no growth)',
    (getEphemeralProgressFrame('toolA') as { data: { elapsedTimeSeconds: number } }).data
      .elapsedTimeSeconds === 60)
  check("only toolA's subscriber woke — 60 times", wakesA === 60, String(wakesA))
  check("toolB's subscriber NEVER woke (per-key isolation — the one-row law)", wakesB === 0, String(wakesB))

  publishEphemeralProgress(tick('toolB', 1))
  check('a toolB tick wakes toolB once and toolA not again', wakesB === 1 && wakesA === 60)

  clearEphemeralProgress()
  check('clear drops every frame and wakes every subscriber',
    getEphemeralProgressFrame('toolA') === undefined &&
      getEphemeralProgressFrame('toolB') === undefined &&
      wakesA === 61 &&
      wakesB === 2)
  unsubA()
  unsubB()
  publishEphemeralProgress(tick('toolA', 1))
  check('unsubscribed callbacks never fire again', wakesA === 61)
  _resetEphemeralProgressForTesting()
}

section('§B the ephemeral classifier (which frames belong in the store)')
{
  check('bash/powershell/mcp progress are ephemeral',
    isEphemeralToolProgress('bash_progress') &&
      isEphemeralToolProgress('powershell_progress') &&
      isEphemeralToolProgress('mcp_progress'))
  check('agent/hook/skill progress are NOT (their trails accumulate)',
    !isEphemeralToolProgress('agent_progress') &&
      !isEphemeralToolProgress('hook_progress') &&
      !isEphemeralToolProgress('skill_progress'))
}

section('§C wiring pins — the transcript never sees an ephemeral frame')
{
  // THE WRITE SIDE LIVES AGAIN — the LIVEPAINT road (the arm's named
  // reviver, re-trued at its fold): the runner taps ephemeral progress
  // onto one additive wire frame, the seat folds it into the
  // session-progress projection (clearing on the result frame), and the
  // connector's feed is the store's ONE writer — daemonConnector owns
  // publish AND clear (detach · idle belt · empty map), all driven in
  // prove-live-progress-road §B/§C. These pins hold the healed truth:
  // the doors stand, the read side lives, and the writer census is
  // EXACTLY the connector — a second writer (or a vanished one) reds
  // this section for its own conscious re-true.
  const store = readFileSync(join(import.meta.dir, '..', '..', 'src', 'state', 'ephemeralProgressStore.ts'), 'utf8')
  check('the store doors stand (publish + clear still exported for the revival)',
    store.includes('export function publishEphemeralProgress(') && store.includes('export function clearEphemeralProgress('))
  const writerCensus = ((): string[] => {
    try {
      return execSync(
        "grep -rln 'publishEphemeralProgress(\\|clearEphemeralProgress(' src --include='*.ts' --include='*.tsx'",
        { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') },
      )
        .split('\n')
        .filter(f => f !== '' && f !== 'src/state/ephemeralProgressStore.ts')
    } catch {
      return []
    }
  })()
  check('the store has exactly ONE writer home — daemonConnector (the LIVEPAINT road; a second writer or a vanished one reds this for its own re-true)',
    writerCensus.length === 1 && writerCensus[0] === 'src/services/engine-connector/daemonConnector.ts',
    writerCensus.join(', '))

  const row = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'MessageRow.tsx'), 'utf8')
  check('MessageRow subscribes per-row and appends the live frame LAST',
    row.includes('useEphemeralProgressVersion(toolUseID ? [toolUseID] : [])') &&
      row.includes('return ephemeral ? [...recorded, ephemeral] : recorded'))
  const collapsed = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'CollapsedReadSearchContent.tsx'),
    'utf8',
  )
  check('the collapsed card merges the live frame as the newest',
    collapsed.includes('useEphemeralProgressVersion(memberIds)') &&
      (collapsed.match(/getEphemeralProgressFrame\(id\) \?\?/g) ?? []).length === 2)
  const grouped = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'messages', 'GroupedToolUseContent.tsx'),
    'utf8',
  )
  check('the grouped card subscribes over its member ids and merges',
    grouped.includes('useEphemeralProgressVersion(memberIds)') &&
      grouped.includes('getEphemeralProgressFrame(id)'))
}

section('§D the F2 rider — retired with the screen-era queue surface')
{
  // The screen-era executeQueuedInput/useQueueProcessor road died in the
  // same re-home: the queue drains in the RUNNER era and its
  // per-session laws live in prove-inputsched-contract (AGENTDIALS C6's
  // rekey estate). The hook file stands consumer-less; this pin holds the
  // retirement — a RED here means a screen-side consumer returned and the
  // F2 transcript-stability law must be re-pinned on the living shape.
  const importers = ((): string[] => {
    try {
      return execSync(
        "grep -rln \"from '.*useQueueProcessor\" src --include='*.ts' --include='*.tsx'",
        { encoding: 'utf8', cwd: join(import.meta.dir, '..', '..') },
      )
        .split('\n')
        .filter(f => f !== '')
    } catch {
      return []
    }
  })()
  check('EXPECTED-RETIREMENT: useQueueProcessor has no live importer — a RED means a screen-side consumer returned and the F2 law re-pins on it',
    importers.length === 0,
    importers.join(', '))
}

rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} PROGRESS-PROJECTION PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL PROGRESS-PROJECTION PROOFS PASS')
process.exit(0)
