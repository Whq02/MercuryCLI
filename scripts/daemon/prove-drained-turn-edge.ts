#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const supervisor = await import('../../src/daemon/longLivedSupervisor.ts')
const schemas = await import('../../src/entrypoints/sdk/coreSchemas.ts')
const { TURN_STARTED_SUBTYPE, turnStartedFrame, isTurnStartedParsedFrame, isTurnResultParsedFrame, parseStreamJsonFrame, decideWorkerBusy } = supervisor

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

section('§1 one owner of the frame: the writer\'s shape is the reader\'s predicate')
{
  const frame = turnStartedFrame('sess-1', ['u1', 'u2'], 'uuid-1')
  check('the frame is a system frame with the turn-start subtype and the joined uuids', frame.type === 'system' && frame.subtype === TURN_STARTED_SUBTYPE && j(frame.uuids) === j(['u1', 'u2']) && frame.session_id === 'sess-1' && frame.uuid === 'uuid-1', j(frame))
  const line = JSON.stringify(frame)
  check('the reader recognises the writer\'s line through the same parser the drain uses', isTurnStartedParsedFrame(parseStreamJsonFrame(line)))
  check('…and a result frame, a user frame, a torn line and a foreign system subtype read false', !isTurnStartedParsedFrame(parseStreamJsonFrame('{"type":"result","subtype":"success"}')) && !isTurnStartedParsedFrame(parseStreamJsonFrame('{"type":"user"}')) && !isTurnStartedParsedFrame(parseStreamJsonFrame('{"type":"system","sub')) && !isTurnStartedParsedFrame(parseStreamJsonFrame('{"type":"system","subtype":"status"}')) && !isTurnStartedParsedFrame(null))
  check('the result predicate is untouched (the close edge)', isTurnResultParsedFrame(parseStreamJsonFrame('{"type":"result","subtype":"success"}')) && !isTurnResultParsedFrame(parseStreamJsonFrame(line)))
  const parsed = schemas.SDKTurnStartedMessageSchema().safeParse(JSON.parse(line))
  check('the SDK schema admits the frame as its own member (a lawful stdout message)', parsed.success, j(parsed))
  const union = schemas.SDKMessageSchema().safeParse(JSON.parse(line))
  check('…and the SDK message union carries it', union.success, j(union))
  const uuids = turnStartedFrame('s', [], 'u').uuids
  check('a turn the runner minted itself carries no uuids', Array.isArray(uuids) && uuids.length === 0)
}

section('§2 the busy fact reads the edge')
{
  const now = Date.now()
  const open = decideWorkerBusy({ turnActive: true, turnStartedAt: now - 1_000, now, lastDeliveredAt: undefined })
  check('a seat whose edge is open reads busy — no delivery needed', open.busy === true, j(open))
  const closed = decideWorkerBusy({ turnActive: false, turnStartedAt: undefined, now, lastDeliveredAt: now - 60_000 })
  check('a seat whose edge is closed reads idle', closed.busy === false, j(closed))
}

section('§3 the roster and the print road ride the one owner')
{
  const roster = readFileSync(join(ROOT, 'src/daemon/roster.ts'), 'utf8')
  const drain = roster.slice(roster.indexOf('private drainChildStdout('))
  check('the drain opens the edge on the turn-start frame BEFORE it reads the result frame (one line, both edges)', /isTurnStartedParsedFrame\(frame\)[\s\S]{0,1200}ll\.turnActive = true[\s\S]{0,80}ll\.turnStartedAt = Date\.now\(\)/.test(drain) && drain.includes('isTurnStartedParsedFrame(frame)') && drain.indexOf('isTurnStartedParsedFrame(frame)') < drain.indexOf('isTurnResultParsedFrame(frame)'))
  check('reply() still opens the edge for a delivery (the same fact, two roads into one field)', /h\.longLived\.turnActive = true\n\s*h\.longLived\.turnStartedAt = Date\.now\(\)/.test(roster))
  const print = readFileSync(join(ROOT, 'src/cli/print.ts'), 'utf8')
  const onTurnStart = print.slice(print.indexOf('onTurnStart: (command, batch) => {'), print.indexOf('onTurnStart: (command, batch) => {') + 900)
  check('the print road writes the frame at the turn\'s start through the owner, before the replay acks', /io\.outbound\.enqueue\(\s*turnStartedFrame\(/.test(onTurnStart) && onTurnStart.includes('turnStartedFrame(') && onTurnStart.indexOf('turnStartedFrame(') < onTurnStart.indexOf('replayUserMessages'))
  check('the frame never becomes the run\'s last message (excluded like the other bookkeeping frames)', /EXCLUDED_SYSTEM_SUBTYPES = new Set\(\[\s*TURN_STARTED_SUBTYPE,/.test(print))
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
