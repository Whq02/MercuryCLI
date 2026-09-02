#!/usr/bin/env bun
// ============================================================================
//  scripts/longrun-invariants/prove-ref-observability.ts — items 3+4: the
//  agent final-report selector and the one-Inspect workflow status, proven
//  through the PRODUCTION resource adapters (no second parser anywhere).
//
//  The guarded field class: a task-notification envelope advertising
//  `full output: mercury://agent/<id>` while the adapter reads only the task
//  .output path — the agent hand-writes a throwaway JSONL parser repeatedly
//  to get its verification agent's final report; workflow monitoring meant
//  hand-parsing run.json on a schema guessed by trial (`status` vs `state`),
//  because the run Inspect carried no phase state and /workflows is TUI-only.
//  AFTER (pinned here):
//   · mercury://agent/<id>?child=report answers with the CANONICAL transcript
//     projection (readAgentTranscript — the same one /workflows renders):
//     final text, explicit running / absent / truncated states.
//   · one Inspect of mercury://workflow/<runId> answers status + liveness +
//     phases + per-agent state from the canonical manifest reader — the
//     model never reads run.json.
//   · ?child=<agentId> returns the structured projection, raw lines only on
//     explicit lines/q/cursor selectors.
//
//  Run:  ~/.bun/bin/bun run scripts/longrun-invariants/prove-ref-observability.ts
//  Proof hygiene: mkdtemp scratch, synthetic fixtures modeled on the real
//  AVS shapes (the live file is ambient machine state — never read here).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The REGISTRY is the production entry (its adapter imports must evaluate
// first — importing an adapter module as the proof's entry trips the cycle's
// TDZ that production never sees). Resolution below rides the registry seam.
import {
  getResourceAdapter,
} from '../../src/services/resources/registry.js'
import { parseMercuryRef, type ResourceContext, type ResourceAdapter } from '../../src/services/resources/contracts.js'
import { formatEnvelopeBlock } from '../../src/services/agentResults/normalize.js'
import type { AgentResultEnvelope } from '../../src/services/agentResults/contracts.js'
import { makeOwnerKey } from '../../src/services/run/ownerKey.js'
import { OUTCOME_CAP_CHARS } from '../../src/tools/WorkflowTool/agentTranscriptReader.js'
import { workflowRunsRoot, RUN_MANIFEST_VERSION } from '../../src/tools/WorkflowTool/runManifest.js'
import { entryToRecord } from '../../src/fabric/entryCodec.js'
import { ordinalOf } from '../../src/fabric/ordinal.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'vigil-refs-'))
const owner = makeOwnerKey({ workspace: scratch, sessionId: 'vigil-refs', lane: 'main' })

/** A minimal but REAL-shaped agent transcript (the AVS verification agent's
 *  structure: string prompt entry, tool_use/tool_result pairs, final text),
 *  laid down as the record lines the transcript writer produces — the
 *  reader decodes records, never raw entries. */
function writeAgentTranscript(file: string, opts: { finalText?: string }): void {
  const entries: Record<string, unknown>[] = [
    { type: 'user', message: { role: 'user', content: 'You are verifying an uncommitted documentation change…' } },
    {
      type: 'assistant',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git diff --stat' } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '4 files changed' }] } },
    ...(opts.finalText !== undefined
      ? [
          {
            type: 'assistant',
            message: { id: 'msg_2', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: opts.finalText }] },
          },
        ]
      : []),
  ]
  let ordinal = 0
  const writer = {
    sessionId: 'vigil-refs' as never,
    nextOrdinal: () => ordinalOf(++ordinal),
    observedAt: '2026-06-19T12:00:00.000Z',
    source: { channel: 'sdk' } as const,
  }
  writeFileSync(file, entries.map(e => JSON.stringify(entryToRecord(e, writer as never))).join('\n') + '\n')
}

type TaskRow = { id: string; type: string; status: string; description: string; startTime: number; endTime?: number; outputFile?: string }
const tasks: Record<string, TaskRow> = {}
const ctx: ResourceContext = {
  owner,
  cwd: scratch,
  getAppState: () => ({ tasks }),
}
const agentAdapter = getResourceAdapter('agent')!
const workflowAdapter = getResourceAdapter('workflow')!
check('setup: registry serves both adapters', !!agentAdapter && !!workflowAdapter)
const resolveRef = async (adapter: ResourceAdapter, raw: string) => {
  const ref = parseMercuryRef(raw)
  if (!ref) throw new Error(`unparseable ref ${raw}`)
  return adapter.resolve(ref, ctx)
}

// ============================================================================
console.log('\n=== items 3: mercury://agent/<id>?child=report (canonical projection) ===')
// ============================================================================
{
  // (a) completed agent with a final report — ONE Inspect, no parser.
  const doneFile = join(scratch, 'agent-done.jsonl')
  writeAgentTranscript(doneFile, { finalText: 'All four spot-checked findings are genuinely closed in source. Final report.' })
  tasks['ag-done'] = { id: 'ag-done', type: 'agent', status: 'completed', description: 'verify docs', startTime: 1, endTime: 2, outputFile: doneFile }
  const done = await resolveRef(agentAdapter, 'mercury://agent/ag-done?child=report')
  check('completed report resolves ok', done.state === 'ok')
  if (done.state === 'ok') {
    check('…text IS the final report', done.resource.text?.startsWith('All four spot-checked findings') === true, done.resource.text?.slice(0, 60))
    const s = done.resource.structured as { running?: boolean; hasFinalText?: boolean }
    check('…structured says settled + hasFinalText', s.running === false && s.hasFinalText === true)
  }

  // (b) RUNNING agent — explicit not-final state, never a silent partial.
  const liveFile = join(scratch, 'agent-live.jsonl')
  writeAgentTranscript(liveFile, { finalText: 'interim thoughts…' })
  tasks['ag-live'] = { id: 'ag-live', type: 'agent', status: 'running', description: 'hunting', startTime: 1, outputFile: liveFile }
  const live = await resolveRef(agentAdapter, 'mercury://agent/ag-live?child=report')
  check('running report resolves ok', live.state === 'ok')
  if (live.state === 'ok') {
    check('…summary carries REPORT NOT FINAL', live.resource.summary.includes('REPORT NOT FINAL'))
    check('…text marks the running state', live.resource.text?.includes('RUNNING') === true)
  }

  // (c) running agent with NO text yet — honest empty, latest activity shown.
  const quietFile = join(scratch, 'agent-quiet.jsonl')
  writeAgentTranscript(quietFile, {})
  tasks['ag-quiet'] = { id: 'ag-quiet', type: 'agent', status: 'running', description: 'starting', startTime: 1, outputFile: quietFile }
  const quiet = await resolveRef(agentAdapter, 'mercury://agent/ag-quiet?child=report')
  check('no-text-yet resolves ok with honest note', quiet.state === 'ok' && quiet.resource.text?.includes('no report yet') === true)

  // (d) ABSENT — an id with no task and no transcript answers absent.
  const absent = await resolveRef(agentAdapter, 'mercury://agent/nope?child=report')
  check('unknown agent answers absent (never an empty ok)', absent.state === 'absent')

  // (e) TRUNCATION honesty — an over-cap final text is marked, never silent.
  const bigFile = join(scratch, 'agent-big.jsonl')
  writeAgentTranscript(bigFile, { finalText: 'R'.repeat(OUTCOME_CAP_CHARS + 500) })
  tasks['ag-big'] = { id: 'ag-big', type: 'agent', status: 'completed', description: 'long report', startTime: 1, endTime: 2, outputFile: bigFile }
  const big = await resolveRef(agentAdapter, 'mercury://agent/ag-big?child=report')
  check('over-cap report is MARKED truncated', big.state === 'ok' && big.resource.text?.includes('[report truncated') === true)

  // (f) the detail view advertises the report child.
  const detail = await resolveRef(agentAdapter, 'mercury://agent/ag-done')
  check('detail view advertises ?child=report', detail.state === 'ok' && (detail.resource.children ?? []).some(c => c.ref.endsWith('?child=report')))

  // (g) the envelope block advertises the selector (the field agent had "no
  // documented way to ask for just the final assistant message").
  const env: AgentResultEnvelope = {
    version: 1,
    agentId: 'ag-done',
    status: 'completed',
    summary: 's',
    findings: [],
    changedPaths: [],
    failedAttempts: 0,
    artifacts: [],
    checks: [],
    unresolved: [],
    fullOutputRef: 'mercury://agent/ag-done',
  } as unknown as AgentResultEnvelope
  check('envelope advertises ?child=report', formatEnvelopeBlock(env).includes('mercury://agent/ag-done?child=report'))
}

// ============================================================================
console.log('\n=== item 4: one Inspect of mercury://workflow/<runId> ===')
// ============================================================================
{
  const runId = 'wf-vigil-1'
  const runDir = join(workflowRunsRoot(scratch), runId)
  const transcriptDir = join(runDir, 'transcripts')
  mkdirSync(transcriptDir, { recursive: true })
  writeAgentTranscript(join(transcriptDir, 'agent-a1.jsonl'), { finalText: 'phase-1 agent report' })
  writeAgentTranscript(join(transcriptDir, 'agent-a2.jsonl'), {})
  const manifest = {
    version: RUN_MANIFEST_VERSION,
    runId,
    workflowName: 'vigil-fixture',
    phases: [
      { title: 'Scan', detail: 'find things' },
      { title: 'Verify', detail: 'check them' },
    ],
    transcriptDir,
    runDir,
    startTime: 1000,
    ownerPid: process.pid,
    status: 'running',
    agentCount: 2,
    totalTokens: 1234,
    agents: [
      { agentId: 'a1', index: 0, label: 'scan:left', state: 'done', phaseIndex: 0, phaseTitle: 'Scan' },
      { agentId: 'a2', index: 1, label: 'verify:left', state: 'progress', phaseIndex: 1, phaseTitle: 'Verify' },
    ],
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(manifest))

  // ONE Inspect: run + phase + liveness + agent state — no run.json read.
  const run = await resolveRef(workflowAdapter, `mercury://workflow/${runId}`)
  check('run Inspect resolves ok', run.state === 'ok')
  if (run.state === 'ok') {
    const text = run.resource.text ?? ''
    check('…status + liveness present', /status: running \(live\)/.test(text), text.split('\n')[0])
    check('…PHASES present with per-phase agent state', text.includes('phases (2):') && /Scan — 1 agent\(s\): 1 done/.test(text), text)
    check('…second phase shows its progress agent', /Verify — 1 agent\(s\): 1 progress/.test(text))
    check('…agents listed with state + phase', /a2 — progress · verify:left · phase Verify/.test(text))
    const s = run.resource.structured as { liveness?: string; phases?: unknown[]; agentStates?: Record<string, string> }
    check('…structured carries liveness/phases/agentStates', s.liveness === 'live' && Array.isArray(s.phases) && s.agentStates?.a2 === 'progress')
  }

  // Agent child: the canonical projection (not raw JSONL).
  const child = await resolveRef(workflowAdapter, `mercury://workflow/${runId}?child=a1`)
  check('agent child resolves ok', child.state === 'ok')
  if (child.state === 'ok') {
    const t = child.resource.text ?? ''
    check('…child returns the PROJECTION (OUTCOME), not raw lines', t.includes('OUTCOME:') && t.includes('phase-1 agent report'))
    check('…no raw JSONL braces leak', !t.includes('"type":"assistant"'))
  }
  // Raw stream stays reachable on explicit selectors (the file's own record
  // lines, payload and all — never the projection).
  const raw = await resolveRef(workflowAdapter, `mercury://workflow/${runId}?child=a1&lines=1-2`)
  check('explicit lines selector still reads the raw stream', raw.state === 'ok' && (raw.resource.text ?? '').includes('"payload"'))

  // Absent honesty.
  const noRun = await resolveRef(workflowAdapter, 'mercury://workflow/nope')
  check('unknown run answers absent', noRun.state === 'absent')
  const noAgent = await resolveRef(workflowAdapter, `mercury://workflow/${runId}?child=zz`)
  check('unknown agent child answers absent + names the real agents', noAgent.state === 'absent' && noAgent.state === 'absent' && (noAgent as { note: string }).note.includes('a1'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ ALL PASS — one Inspect, no second parser' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
