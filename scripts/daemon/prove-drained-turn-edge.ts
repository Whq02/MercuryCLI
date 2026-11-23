#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const daemon = await import('../../src/daemon/roster/longLivedRespawn.ts')
const { RowSchema } = await import('../../src/engine/rows/vocabulary.ts')
const { turnStartedRow, outcomeRow, createRowStamper } = await import('../../src/engine/rows/project.ts')
const { isTurnOpenRow, isOutcomeRow, decideWorkerBusy } = daemon
const { parseRow: parseRunnerLine } = await import('../../src/engine/rows/read.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

section('§1 one owner of the row: the projector\'s shape is the reader\'s predicate')
{
  const stamper = createRowStamper(() => '2026-10-02T00:00:00.000Z')
  const row = stamper.stamp(turnStartedRow({ session_id: 'sess-1', turn: 1 }, { turnId: 'turn-1', messageIds: ['u1', 'u2'], model: 'm' }))
  check('the row is a turn row in the started state with the joined message ids', row.type === 'turn' && row.state === 'started' && j(row.message_ids) === j(['u1', 'u2']) && row.session_id === 'sess-1' && row.turn_id === 'turn-1', `${j(row)} — turnStartedRow in src/engine/rows/project.ts builds this row`)
  const line = JSON.stringify(row)
  check('the reader recognises the projector\'s line through the one row reader', isTurnOpenRow(parseRunnerLine(line)), `isTurnOpenRow in src/daemon/roster/longLivedRespawn.ts read false for the line ${line.slice(0, 160)}: it must accept the turn row in the started state that turnStartedRow (src/engine/rows/project.ts) writes`)
  const USAGE = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
  const outcome = JSON.stringify(stamper.stamp(outcomeRow({ session_id: 'sess-1', turn: 1 }, { turnId: 'turn-1', status: 'completed', stopReason: 'end_turn', answer: '', steps: 1, wallMs: 1, usage: USAGE, models: [], denials: [] })))
  check('…and an outcome row, a text row, a torn line and a waiting turn row read false', !isTurnOpenRow(parseRunnerLine(outcome)) && !isTurnOpenRow(parseRunnerLine('{"type":"text","text":"hi"}')) && !isTurnOpenRow(parseRunnerLine(line.slice(0, 30))) && !isTurnOpenRow(parseRunnerLine('{"type":"turn","state":"waiting","turn_id":"t","agents":2}')), 'isTurnOpenRow in src/daemon/roster/longLivedRespawn.ts must read true only for a turn row in the started state')
  check('the outcome predicate is untouched (the close edge)', isOutcomeRow(parseRunnerLine(outcome)) && !isOutcomeRow(parseRunnerLine(line)), 'isOutcomeRow in src/daemon/roster/longLivedRespawn.ts must read true for the outcome row of outcomeRow (src/engine/rows/project.ts) and false for a turn row')
  const parsed = RowSchema().safeParse(JSON.parse(line))
  check('the row schema admits the row as its own member (a lawful stdout row)', parsed.success, `${j(parsed)} — the row built by turnStartedRow (src/engine/rows/project.ts) must be a member of RowSchema in src/engine/rows/vocabulary.ts`)
  const minted = turnStartedRow({ session_id: 's', turn: 1 }, { turnId: 't', messageIds: [], model: 'm' }).message_ids
  check('a turn the runner minted itself carries no message ids', Array.isArray(minted) && minted.length === 0, 'turnStartedRow in src/engine/rows/project.ts must give an empty message_ids when it is handed none')
}

section('§2 the busy fact reads the edge')
{
  const now = Date.now()
  const open = decideWorkerBusy({ turnActive: true, turnStartedAt: now - 1_000, now, lastDeliveredAt: undefined })
  check('a seat whose edge is open reads busy — no delivery needed', open.busy === true, `${j(open)} — decideWorkerBusy in src/daemon/roster/longLivedRespawn.ts must read busy while turnActive is true`)
  const closed = decideWorkerBusy({ turnActive: false, turnStartedAt: undefined, now, lastDeliveredAt: now - 60_000 })
  check('a seat whose edge is closed reads idle', closed.busy === false, `${j(closed)} — decideWorkerBusy in src/daemon/roster/longLivedRespawn.ts must read idle when turnActive is false`)
}


console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
