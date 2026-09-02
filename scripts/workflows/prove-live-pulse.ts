#!/usr/bin/env bun
// ============================================================================
//  prove-live-pulse — the background-workflow liveness pulse.
//
//  AVS friction audit: the operator killed a HEALTHY run ("i
//  suspected it might be stuck?") and later trusted a dead one — run health
//  had no one-glance surface outside the wide cockpit. The fix is ONE pure
//  projector (livePulse.ts) read by three surfaces: the transcript result
//  line (+ the /tasks <id> probe pointer), the MercuryFrame statusbar chip,
//  and the /tasks WorkflowDetailDialog probe row.
//
//  Behavioral legs exercise the REAL leaf; structural legs pin the three
//  surfaces to the shared projector (so they can never disagree) and the
//  render-cheap tick discipline (10s coarse, parked when idle).
// ============================================================================
import { readFileSync } from 'node:fs'
import {
  formatQuietAge,
  WORKFLOW_QUIET_MS,
  workflowPulse,
} from '../../src/tools/WorkflowTool/livePulse.js'
import type { WorkflowProgressEvent } from '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const T0 = 1_000_000_000_000

console.log('— empty run (just launched) —')
const p0 = workflowPulse([], T0, T0 + 5_000)
t('lastEventAt floors at startTime', p0.lastEventAt === T0)
t('quietMs from startTime', p0.quietMs === 5_000)
t('fresh run is moving', p0.moving === true)
t('no agents yet', p0.running === 0 && p0.settled === 0 && p0.maxAttempt === 0)

console.log('— recency comes from event stamps, not array order —')
const events: WorkflowProgressEvent[] = [
  { type: 'workflow_phase', index: 0, title: 'Scan' },
  {
    type: 'workflow_agent',
    index: 0,
    label: 'scan:a',
    state: 'done',
    phaseTitle: 'Scan',
    lastProgressAt: T0 + 60_000,
    attempt: 5, // settled — must NOT drive maxAttempt
  },
  {
    type: 'workflow_agent',
    index: 1,
    label: 'verify:b',
    state: 'progress',
    phaseTitle: 'Verify',
    startedAt: T0 + 70_000,
    lastProgressAt: T0 + 100_000,
    attempt: 2,
  },
  { type: 'workflow_phase', index: 1, title: 'Verify' },
  {
    type: 'workflow_agent',
    index: 2,
    label: 'verify:c',
    state: 'start',
    phaseTitle: 'Verify',
    queuedAt: T0 + 90_000,
  },
]
const p1 = workflowPulse(events, T0, T0 + 130_000)
t('lastEventAt is the max stamp', p1.lastEventAt === T0 + 100_000)
t('quietMs measured from it', p1.quietMs === 30_000)
t('still moving under the threshold', p1.moving === true)
t('running counts start+progress', p1.running === 2)
t('settled counts done/error', p1.settled === 1)
t('maxAttempt reads LIVE agents only (settled attempt 5 ignored)', p1.maxAttempt === 2)
t('phase follows the newest agent signal', p1.phaseTitle === 'Verify')

console.log('— the quiet boundary —')
const pEdgeUnder = workflowPulse(events, T0, T0 + 100_000 + WORKFLOW_QUIET_MS - 1)
const pEdgeAt = workflowPulse(events, T0, T0 + 100_000 + WORKFLOW_QUIET_MS)
t('1ms under the threshold: moving', pEdgeUnder.moving === true)
t('at the threshold: quiet', pEdgeAt.moving === false)
t('clock skew never yields negative quiet', workflowPulse(events, T0, T0).quietMs === 0)

console.log('— the age word —')
t("8s", formatQuietAge(8_000) === '8s')
t("59s", formatQuietAge(59_999) === '59s')
t("4m", formatQuietAge(240_000) === '4m')
t("1h", formatQuietAge(3_600_000) === '1h')
t("1h15m", formatQuietAge(4_500_000) === '1h15m')

console.log('— the three surfaces share the ONE projector —')
const renderers = readFileSync('src/tools/WorkflowTool/workflowToolRenderers.tsx', 'utf8')
t('transcript line reads workflowPulse', renderers.includes("from './livePulse.js'") && renderers.includes('workflowPulse(task.workflowProgress'))
t('transcript line carries the age heartbeat', renderers.includes('last event {formatQuietAge(pulse.quietMs)} ago'))
t('quiet age turns AMBER on the transcript line', renderers.includes('pulse.moving ? FAINT : AMBER'))
t('transcript line carries the /tasks <id> probe pointer', renderers.includes('/tasks {taskId}'))
t('transcript tick is coarse AND parked when settled', renderers.includes('useNowTick(live ? 10_000 : null)'))
const frame = readFileSync('src/components/MercuryFrame.tsx', 'utf8')
t('statusbar chip reads the shared projector', frame.includes("from '../tools/WorkflowTool/livePulse.js'"))
t('statusbar chip mounted in the status row', frame.includes('{wfNode}'))
t('statusbar chip shows the WORST pulse (an active run must not mask a stuck one)', frame.includes('a.quietMs >= b.quietMs ? a : b'))
t('statusbar tick parked when no workflow runs', frame.includes('useNowTick(wfLive.length > 0 ? 10_000 : null)'))
const dialog = readFileSync('src/components/tasks/WorkflowDetailDialog.tsx', 'utf8')
t('/tasks detail card reads the shared projector', dialog.includes("from '../../tools/WorkflowTool/livePulse.js'"))
t('/tasks probe row renders the moving/quiet verdict', dialog.includes('moving') && dialog.includes('quiet {formatQuietAge(pulse.quietMs)}'))
t('/tasks probe row surfaces retry-ladder attempts', dialog.includes('(attempt ${pulse.maxAttempt})'))

console.log(failures ? '\n❌ LIVE-PULSE RED' : '\n✅ LIVE-PULSE GREEN')
process.exit(failures)
