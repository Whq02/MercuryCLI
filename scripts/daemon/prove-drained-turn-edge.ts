#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const supervisor = await import('../../src/daemon/longLivedSupervisor.ts')
const { RowSchema } = await import('../../src/rows/vocabulary.ts')
const { turnStartedRow, outcomeRow, createRowStamper } = await import('../../src/rows/project.ts')
const { isTurnOpenRow, isOutcomeRow, decideWorkerBusy } = supervisor
const { parseRow: parseRunnerLine } = await import('../../src/rows/read.ts')

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
  check('the row is a turn row in the started state with the joined message ids', row.type === 'turn' && row.state === 'started' && j(row.message_ids) === j(['u1', 'u2']) && row.session_id === 'sess-1' && row.turn_id === 'turn-1', j(row))
  const line = JSON.stringify(row)
  check('the reader recognises the projector\'s line through the one row reader', isTurnOpenRow(parseRunnerLine(line)))
  const USAGE = { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }
  const outcome = JSON.stringify(stamper.stamp(outcomeRow({ session_id: 'sess-1', turn: 1 }, { turnId: 'turn-1', status: 'completed', stopReason: 'end_turn', answer: '', steps: 1, wallMs: 1, usage: USAGE, models: [], denials: [] })))
  check('…and an outcome row, a text row, a torn line and a waiting turn row read false', !isTurnOpenRow(parseRunnerLine(outcome)) && !isTurnOpenRow(parseRunnerLine('{"type":"text","text":"hi"}')) && !isTurnOpenRow(parseRunnerLine(line.slice(0, 30))) && !isTurnOpenRow(parseRunnerLine('{"type":"turn","state":"waiting","turn_id":"t","agents":2}')))
  check('the outcome predicate is untouched (the close edge)', isOutcomeRow(parseRunnerLine(outcome)) && !isOutcomeRow(parseRunnerLine(line)))
  const parsed = RowSchema().safeParse(JSON.parse(line))
  check('the row schema admits the row as its own member (a lawful stdout row)', parsed.success, j(parsed))
  const minted = turnStartedRow({ session_id: 's', turn: 1 }, { turnId: 't', messageIds: [], model: 'm' }).message_ids
  check('a turn the runner minted itself carries no message ids', Array.isArray(minted) && minted.length === 0)
}

section('§2 the busy fact reads the edge')
{
  const now = Date.now()
  const open = decideWorkerBusy({ turnActive: true, turnStartedAt: now - 1_000, now, lastDeliveredAt: undefined })
  check('a seat whose edge is open reads busy — no delivery needed', open.busy === true, j(open))
  const closed = decideWorkerBusy({ turnActive: false, turnStartedAt: undefined, now, lastDeliveredAt: now - 60_000 })
  check('a seat whose edge is closed reads idle', closed.busy === false, j(closed))
}

section('§3 the roster and the runner ride the one owner')
{
  const roster = readFileSync(join(ROOT, 'src/daemon/roster.ts'), 'utf8')
  const classify = roster.slice(roster.indexOf('classifyRow('))
  check('the row hook opens the edge on the turn row BEFORE it reads the outcome row (one row, both edges)', /isTurnOpenRow\(frame\)[\s\S]{0,1200}ll\.turnActive = true[\s\S]{0,80}ll\.turnStartedAt = Date\.now\(\)[\s\S]{0,400}isOutcomeRow\(frame\)/.test(classify))
  check('reply() opens the edge for a delivery before the answer is read (the same fact, two roads into one field)', /ll\.turnActive = true\n\s*ll\.turnStartedAt = Date\.now\(\)[\s\S]{0,600}await door\.deliver\(row\)/.test(roster))
  const print = readFileSync(join(ROOT, 'src/cli/run.ts'), 'utf8')
  check('the runner mints the open row through the owner when the driver asks for one', /openTurnRow: messageIds => \{[\s\S]{0,300}return turnStartedRow\(/.test(print))
  const turn = readFileSync(join(ROOT, 'src/rows/turn.ts'), 'utf8')
  check('the turn itself opens with its own row, before any row of its stream', /yield turnStartedRow\(scope, \{ turnId, messageIds, model: resolvedModel \}\)/.test(turn) && turn.indexOf('yield turnStartedRow(') !== -1 && turn.indexOf('for await (const event of queryEvents(') !== -1 && turn.indexOf('yield turnStartedRow(') < turn.indexOf('for await (const event of queryEvents('))
  const driver = readFileSync(join(ROOT, 'src/cli/headless/turnDriver.ts'), 'utf8')
  check('the driver marks the turn open on its row and mints one only before an outcome of a turn that never opened', /if \(turnOpened\(row\)\) turnOpen = true/.test(driver) && /if \(isOutcome\(row\)\) \{[\s\S]{0,300}openIfUnopened\(\)/.test(driver))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
