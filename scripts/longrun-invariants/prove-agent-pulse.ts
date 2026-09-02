#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-agent-pulse.ts — liveness explainability.
//
//  What the code did vs the invariant it missed: the executor emits
//  `waiting: prefill` / `waiting: provider-backoff` / retryInMs /
//  retryAttempt / lastAttemptReason / lastProgressAt on its frames, but
//  buildAgentSummaries dropped all of them — so every no-tool state rendered
//  as "thinking" and a long provider wait showed a stale tool line as
//  current activity on the run view, the inspector and the workflow ref.
//
//  The invariant: the manifest summary CARRIES the producer's liveness
//  fields, and ONE derivation (livePulse.agentPulse) turns them into the
//  display truth every consumer shares — a provider wait is named, a prefill
//  wait is named, and a tool line older than the quiet bar demotes to
//  history instead of presenting as current.
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'agent-pulse-home-'))

const { buildAgentSummaries } = await import('../../src/tools/WorkflowTool/runManifest.js')
const { agentPulse, agentPulseWord, WORKFLOW_QUIET_MS } = await import(
  '../../src/tools/WorkflowTool/livePulse.js'
)
import type { WorkflowProgressEvent } from '../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const NOW = 1_000_000_000

section('§A the manifest summary carries the producer liveness fields')
{
  const events: WorkflowProgressEvent[] = [
    {
      type: 'workflow_agent',
      index: 1,
      label: 'researcher',
      state: 'progress',
      agentId: 'agA',
      waiting: 'provider-backoff',
      retryInMs: 45_000,
      retryAttempt: 2,
      lastAttemptReason: 'stalled',
      lastProgressAt: NOW - 5_000,
      startedAt: NOW - 60_000,
    } as never,
  ]
  const [row] = buildAgentSummaries(events)
  check('waiting carried', row?.waiting === 'provider-backoff', String(row?.waiting))
  check('retryInMs carried', row?.retryInMs === 45_000, String(row?.retryInMs))
  check('retryAttempt carried', row?.retryAttempt === 2, String(row?.retryAttempt))
  check('lastAttemptReason carried', row?.lastAttemptReason === 'stalled')
  check('lastProgressAt carried', row?.lastProgressAt === NOW - 5_000)
  check('an unknown waiting value is dropped, never invented', (() => {
    const [r] = buildAgentSummaries([
      { type: 'workflow_agent', index: 1, label: 'x', state: 'progress', waiting: 'bogus' } as never,
    ])
    return r?.waiting === undefined
  })())
}

section('§B ONE derivation: waits are named, stale tool lines demote')
{
  const backoff = agentPulse(
    { state: 'progress', waiting: 'provider-backoff', retryInMs: 45_000, retryAttempt: 2 },
    NOW,
  )
  check("provider wait derives 'backoff', never thinking",
    backoff.kind === 'backoff', backoff.kind)
  const wordB = agentPulseWord(backoff)
  check('the backoff word names the wait, the attempt and the horizon',
    /provider backoff/.test(wordB) && /retry 2/.test(wordB) && /~45s/.test(wordB), wordB)

  const prefill = agentPulse({ state: 'progress', waiting: 'prefill' }, NOW)
  check("prefill derives 'first-token'", prefill.kind === 'first-token')
  check('the prefill word says so', /awaiting first token/.test(agentPulseWord(prefill)))

  const fresh = agentPulse(
    { state: 'progress', lastProgressAt: NOW - 2_000, lastToolName: 'Read', lastToolSummary: 'a.ts' },
    NOW,
  )
  check('a FRESH signal keeps the tool line current',
    fresh.kind === 'working' && fresh.toolLine === 'Read(a.ts)', JSON.stringify(fresh))

  const stale = agentPulse(
    {
      state: 'progress',
      lastProgressAt: NOW - WORKFLOW_QUIET_MS - 30_000,
      lastToolName: 'Read',
      lastToolSummary: 'a.ts',
    },
    NOW,
  )
  check('a STALE signal demotes the tool line to history (quiet)',
    stale.kind === 'quiet', stale.kind)
  const wordS = agentPulseWord(stale)
  check("the quiet word says 'last:' — never presenting the call as current",
    /^quiet /.test(wordS) && /last: Read\(a\.ts\)/.test(wordS), wordS)

  check('no-tool fresh progress is honestly thinking',
    agentPulseWord(agentPulse({ state: 'progress', lastProgressAt: NOW - 1_000 }, NOW)) === 'thinking')
  check('queued and settled states derive their own kinds',
    agentPulse({ state: 'start' }, NOW).kind === 'queued' &&
      agentPulse({ state: 'done' }, NOW).kind === 'settled' &&
      agentPulse({ state: 'stopped' }, NOW).kind === 'settled')

  // Staleness outranks waiting: a LIVE backoff re-emits on the recovery
  // heartbeat, so a stale lastProgressAt means the producer went silent —
  // a dead run's last backoff frame must read quiet, not an eternal wait.
  const staleBackoff = agentPulse(
    {
      state: 'progress',
      waiting: 'provider-backoff',
      retryInMs: 45_000,
      lastProgressAt: NOW - WORKFLOW_QUIET_MS - 60_000,
    },
    NOW,
  )
  check('a STALE backoff demotes to quiet (staleness outranks waiting)',
    staleBackoff.kind === 'quiet', staleBackoff.kind)
  const freshBackoff = agentPulse(
    { state: 'progress', waiting: 'provider-backoff', retryInMs: 45_000, lastProgressAt: NOW - 3_000 },
    NOW,
  )
  check('a FRESH backoff still names the wait', freshBackoff.kind === 'backoff')
}

section('§C the three consumers read the same derivation (wiring pins)')
{
  const run = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'RunDetailPane.tsx'),
    'utf8',
  )
  check('run view: lane live-line reads agentPulse',
    (run.match(/agentPulse\(agent, now\)/g) ?? []).length >= 2)
  check('run view: dossier now-row lets the pulse OVERRIDE the tool line',
    run.includes('pulseOverride ??'))
  const insp = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'components', 'tasks', 'AgentInspectorPane.tsx'),
    'utf8',
  )
  check('inspector: head meta names backoff/prefill/quiet',
    insp.includes('agentPulse(summary, clockNow)') && insp.includes('agentPulseWord(pulse)'))
  const adapter = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'resources', 'adapters', 'workflow.ts'),
    'utf8',
  )
  check('workflow ref: in-flight agent lines carry the pulse word',
    adapter.includes('agentPulseWord(p)'))
}

rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} AGENT-PULSE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL AGENT-PULSE PROOFS PASS')
