#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  getResourceAdapter,
} from '../../src/services/resources/registry.js'
import { parseMercuryRef, type ResourceContext, type ResourceAdapter } from '../../src/services/resources/contracts.js'
import { formatEnvelopeBlock } from '../../src/services/agentResults/normalize.js'
import type { AgentResultEnvelope } from '../../src/services/agentResults/contracts.js'
import { makeOwnerKey } from '../../src/services/run/ownerKey.js'
import { OUTCOME_CAP_CHARS } from '../../src/utils/crew/agentTranscriptReader.js'
import { entryToRecord } from '../../src/fabric/entryCodec.js'
import { ordinalOf } from '../../src/fabric/ordinal.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'vigil-refs-'))
const owner = makeOwnerKey({ workspace: scratch, sessionId: 'vigil-refs', lane: 'main' })

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
check('setup: registry serves the agent adapter', !!agentAdapter)
const resolveRef = async (adapter: ResourceAdapter, raw: string) => {
  const ref = parseMercuryRef(raw)
  if (!ref) throw new Error(`unparseable ref ${raw}`)
  return adapter.resolve(ref, ctx)
}

console.log('\n=== items 3: mercury://agent/<id>?child=report (canonical projection) ===')
{
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

  const liveFile = join(scratch, 'agent-live.jsonl')
  writeAgentTranscript(liveFile, { finalText: 'interim thoughts…' })
  tasks['ag-live'] = { id: 'ag-live', type: 'agent', status: 'running', description: 'hunting', startTime: 1, outputFile: liveFile }
  const live = await resolveRef(agentAdapter, 'mercury://agent/ag-live?child=report')
  check('running report resolves ok', live.state === 'ok')
  if (live.state === 'ok') {
    check('…summary carries REPORT NOT FINAL', live.resource.summary.includes('REPORT NOT FINAL'))
    check('…text marks the running state', live.resource.text?.includes('RUNNING') === true)
  }

  const quietFile = join(scratch, 'agent-quiet.jsonl')
  writeAgentTranscript(quietFile, {})
  tasks['ag-quiet'] = { id: 'ag-quiet', type: 'agent', status: 'running', description: 'starting', startTime: 1, outputFile: quietFile }
  const quiet = await resolveRef(agentAdapter, 'mercury://agent/ag-quiet?child=report')
  check('no-text-yet resolves ok with honest note', quiet.state === 'ok' && quiet.resource.text?.includes('no report yet') === true)

  const absent = await resolveRef(agentAdapter, 'mercury://agent/nope?child=report')
  check('unknown agent answers absent (never an empty ok)', absent.state === 'absent')

  const bigFile = join(scratch, 'agent-big.jsonl')
  writeAgentTranscript(bigFile, { finalText: 'R'.repeat(OUTCOME_CAP_CHARS + 500) })
  tasks['ag-big'] = { id: 'ag-big', type: 'agent', status: 'completed', description: 'long report', startTime: 1, endTime: 2, outputFile: bigFile }
  const big = await resolveRef(agentAdapter, 'mercury://agent/ag-big?child=report')
  check('over-cap report is MARKED truncated', big.state === 'ok' && big.resource.text?.includes('[report truncated') === true)

  const detail = await resolveRef(agentAdapter, 'mercury://agent/ag-done')
  check('detail view advertises ?child=report', detail.state === 'ok' && (detail.resource.children ?? []).some(c => c.ref.endsWith('?child=report')))

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

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅ ALL PASS — one Inspect, no second parser' : `❌ ${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
