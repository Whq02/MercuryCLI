#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'contracts-'))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { applyConcourseContractOp, CONTRACT_TEXT_CAP } = await import('../../src/daemon/sessionContract.ts')
const { markConcourseWorkerDelivery, readSessionWorkers } = await import(
  '../../src/daemon/concourseWorkers.ts'
)
const { appendSessionReceipt, readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
import type { ConcourseWorkerRecordV1 } from '../../src/daemon/concourseWorkers.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const NOW = Date.now()
const DIR = join(SCRATCH, 'daemon')
mkdirSync(DIR, { recursive: true })
const SID = 'sess-contract-0001'
const RUNNER = 'concourse-w1'

function seedWorker(): void {
  const rec = {
    schema: 1,
    runnerId: RUNNER,
    sessionId: SID,
    workspaceId: join(SCRATCH, 'ws'),
    isolation: 'exclusive',
    modelKey: 'fable',
    spawnedAt: NOW - 60_000,
    lastLiveAt: NOW,
    title: 'the contract session',
  } as ConcourseWorkerRecordV1
  writeFileSync(join(DIR, 'concourse-workers.json'), `${JSON.stringify({ version: 1, workers: { [RUNNER]: rec } }, null, 1)}\n`)
}
const rec = (): ConcourseWorkerRecordV1 => readSessionWorkers(DIR)[RUNNER]!
const contract = () => rec().contract

console.log('A — the record lifecycle (drafted → acked → active → amended → re-acked → closed; never deleted)')
{
  seedWorker()
  check('A0 a fresh record carries NO contract (additive — old records unaffected)', contract() === undefined)
  const set1 = applyConcourseContractOp(SID, { op: 'set', text: 'Build the widget; touch nothing else.' }, 'operator', DIR)
  check("A1 set drafts: outcome applied, status 'draft', the words verbatim", set1.outcome === 'applied' && contract()?.status === 'draft' && contract()?.text === 'Build the widget; touch nothing else.')
  const set2 = applyConcourseContractOp(SID, { op: 'set', text: 'Build the widget and its tests; touch nothing else.' }, 'operator', DIR)
  check('A2 set on a standing draft REVISES in place (no history entry — the draft was never in force)', set2.outcome === 'applied' && contract()?.status === 'draft' && contract()?.amendments.length === 0 && (contract()?.text ?? '').includes('tests'))
  const ack1 = applyConcourseContractOp(SID, { op: 'ack' }, `worker:${SID.slice(0, 8)}`, DIR)
  check("A3 ack is the worker's signature: draft → 'acknowledged', ackAt stamped", ack1.outcome === 'applied' && contract()?.status === 'acknowledged' && typeof contract()?.ackAt === 'number')
  markConcourseWorkerDelivery(RUNNER, DIR)
  check("A4 the delivery-seam promotion (the ONE invention, strike-able): a delivery on an acknowledged contract lands 'active'", contract()?.status === 'active')
  const amend1 = applyConcourseContractOp(SID, { op: 'amend', text: 'Build the widget; the tests clause did not survive contact.' }, 'operator', DIR)
  check("A5 amend keeps history: status 'amended', amendedAt stamped, the OUTGOING text pushed into amendments", amend1.outcome === 'applied' && contract()?.status === 'amended' && typeof contract()?.amendedAt === 'number' && contract()?.amendments.length === 1 && (contract()?.amendments[0]?.text ?? '').includes('tests'))
  const reack = applyConcourseContractOp(SID, { op: 'ack' }, `worker:${SID.slice(0, 8)}`, DIR)
  markConcourseWorkerDelivery(RUNNER, DIR)
  check("A6 re-ack after amendment re-signs, and the next delivery re-promotes: 'active' again", reack.outcome === 'applied' && contract()?.status === 'active')
  const close1 = applyConcourseContractOp(SID, { op: 'close' }, 'operator', DIR)
  check("A7 close ends the agreement with EVERYTHING kept: status 'closed', text whole, history whole", close1.outcome === 'applied' && contract()?.status === 'closed' && (contract()?.text ?? '').includes('did not survive') && contract()?.amendments.length === 1)
  const set3 = applyConcourseContractOp(SID, { op: 'set', text: 'A second engagement.' }, 'operator', DIR)
  check('A8 NEVER DELETED: a re-draft over closed pushes the closed text into amendments first (2 superseded texts now)', set3.outcome === 'applied' && contract()?.status === 'draft' && contract()?.amendments.length === 2 && contract()?.text === 'A second engagement.')
  check('A9 the text cap is a bound, not a gate (the verb caps, never refuses length)', typeof CONTRACT_TEXT_CAP === 'number' && CONTRACT_TEXT_CAP >= 10_000)
}

console.log("B — the one verb's four ops (typed refusals; the wire's appended action)")
{
  check('B1 unknown session refuses typed', applyConcourseContractOp('no-such', { op: 'set', text: 'x' }, 'operator', DIR).outcome === 'refused')
  seedWorker()
  check('B2 ack with no contract refuses', applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR).outcome === 'refused')
  check('B3 amend with no contract refuses toward set', applyConcourseContractOp(SID, { op: 'amend', text: 'x' }, 'o', DIR).outcome === 'refused')
  check('B4 close with no contract refuses', applyConcourseContractOp(SID, { op: 'close' }, 'o', DIR).outcome === 'refused')
  check('B5 set without words refuses', applyConcourseContractOp(SID, { op: 'set', text: '   ' }, 'o', DIR).outcome === 'refused')
  applyConcourseContractOp(SID, { op: 'set', text: 'the agreement' }, 'o', DIR)
  check('B6 amend on a DRAFT refuses (a draft is not in force — set revises it)', applyConcourseContractOp(SID, { op: 'amend', text: 'y' }, 'o', DIR).outcome === 'refused')
  applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR)
  check('B7 set on an IN-FORCE contract refuses toward amend (history must be kept)', applyConcourseContractOp(SID, { op: 'set', text: 'z' }, 'o', DIR).outcome === 'refused')
  check('B8 a second ack is a noop, never an error', applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR).outcome === 'noop')
  applyConcourseContractOp(SID, { op: 'close' }, 'o', DIR)
  check('B9 a second close is a noop; ack on closed refuses', applyConcourseContractOp(SID, { op: 'close' }, 'o', DIR).outcome === 'noop' && applyConcourseContractOp(SID, { op: 'ack' }, 'w', DIR).outcome === 'refused')

}



console.log('E — ADVISORY ALWAYS (the poison: contract state blocking a tool, a dispatch, or an admission)')
{
  seedWorker()
  applyConcourseContractOp(SID, { op: 'set', text: 'un-acked draft' }, 'o', DIR)
  const before = rec().lastDeliveryAt
  markConcourseWorkerDelivery(RUNNER, DIR)
  check('E1 a delivery lands on an UN-ACKED draft exactly as on no contract (nothing valves on contract state)', before === undefined && typeof rec().lastDeliveryAt === 'number')
}

console.log('F — close-against writes the contract-close receipt through the landed seam')
{
  const home = join(SCRATCH, 'receipts-home')
  mkdirSync(home, { recursive: true })
  appendSessionReceipt(home, SID, {
    at: new Date(NOW).toISOString(),
    by: `worker:${SID.slice(0, 8)}`,
    kind: 'contract-close',
    summary: 'delivered the widget; the tests clause was amended away',
    details: { status: 'active', amendments: 1 },
  })
  const entries = readSessionReceipts(home, SID)
  check("F1 the seam round-trips the 'contract-close' entry (at · by · kind · summary · details)", entries.length === 1 && entries[0]?.kind === 'contract-close' && entries[0]?.by === `worker:${SID.slice(0, 8)}` && (entries[0]?.details as { amendments?: number } | undefined)?.amendments === 1)
}

console.log('G — warm re-surfacing (T3 mechanism 1: at birth, then on cadence, through the estate’s own plumbing)')
{
  {
    const { normalizeAttachmentForAPI } = await import('../../src/services/messages/attachmentText.ts')
    const rows = normalizeAttachmentForAPI({ type: 'contract_reminder', text: 'the work agreement', status: 'in force', amendments: 0, ackOwed: false } as never)
    const words = rows.map(row => (typeof row.message.content === 'string' ? row.message.content : row.message.content.map(block => (block.type === 'text' ? block.text : '')).join('\n'))).join('\n')
    check('G3 the reminder renders through the estate’s system-reminder envelope and never claims force', words.includes('<system-reminder>') && words.includes('never blocks'), words.slice(0, 160))
  }
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-contracts: ALL LAWS HOLD' : `\nprove-contracts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
