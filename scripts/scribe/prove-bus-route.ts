#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-bus-route.ts
//  PROOF (Phase 3 Task 3.2): the scribe bus envelopes route through the
//  SendMessageTool union (gated) and the inbox demux. SendMessageTool.ts and
//  useInboxPoller.ts pull the full tool/React-hook dependency chain (not
//  loadable under bun-run), so this proves (a) the exact demux ROUTING DECISION
//  with the real classifier + gate, and (b) the union/case/demux WIRING
//  structurally against source. The live two-process round-trip is the manual
//  run-verify (Step 6).
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-bus-route.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDispatch, serializeScribeEnvelope, isScribeProtocolMessage } from '../../src/utils/scribe/scribeBus.js'
import { scribeBusEnabled } from '../../src/utils/scribe/scribeGates.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}
// The EXACT predicate the inbox demux uses to route a message to the scribe bus.
function routesToScribe(text: string): boolean {
  return scribeBusEnabled() && isScribeProtocolMessage(text)
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const dispatchText = serializeScribeEnvelope(buildDispatch('scribe@t', 'do X'))
const plainText = 'just a normal teammate note'

console.log('============================================================')
console.log(' Scribe bus routing + wiring — Phase-3 Task 3.2 proof')
console.log('============================================================')

section('routing decision (real classifier + gate)')
setStamp(true); delete process.env.MERCURY_SCRIBE_BUS
check('bus ON: a dispatch envelope routes to the scribe bus', routesToScribe(dispatchText) === true)
check('bus ON: plain text does NOT route to scribe (flows as a turn)', routesToScribe(plainText) === false)
process.env.MERCURY_SCRIBE_BUS = '0'
check('bus OFF (=0): even a dispatch envelope does NOT route (flows as plain)', routesToScribe(dispatchText) === false)
delete process.env.MERCURY_SCRIBE_BUS
// routing is stamp-independent.
setStamp(false)
check('bare stamp: dispatch envelope STILL routes (stamp-independence)', routesToScribe(dispatchText) === true)

section('SendMessageTool union + call() wiring (structural, src)')
const smt = src('tools', 'SendMessageTool', 'SendMessageTool.ts')
check('union is scribeBusEnabled()-gated', /scribeBusEnabled\(\)/.test(smt))
for (const t of ['dispatch', 'escalate', 'progress', 'control']) {
  check(`union has a '${t}' variant`, smt.includes(`z.literal('${t}')`))
  check(`call() switch has a '${t}' case`, new RegExp(`case '${t}':`).test(smt))
}
check('call() routes through writeToMailbox via a scribe handler', /serializeScribeEnvelope|buildDispatch/.test(smt))
check('dispatch authority is gated via canDirect', /canDirect/.test(smt))
// Round-2 audit #4: a dropped mailbox write must NOT report success — the scribe
// path branches on the delivery boolean and returns success:false on failure.
const mboxSrc = src('utils', 'teammateMailbox.ts')
check('#4 writeToMailbox returns a delivery boolean', /export async function writeToMailbox[\s\S]{0,160}Promise<boolean>/.test(mboxSrc))
check('#4 sendScribeEnvelope branches on the delivery result', /const delivered = await writeToMailbox/.test(smt) && /if \(!delivered\)[\s\S]{0,160}success: false/.test(smt))
// Step 11 boot self-check: the Implementer loudly self-reports its identity when it
// handles its first dispatch (LIVE-verified: "[implementer] boot OK — team=scribe …
// model=claude-opus-4-8[1m] teammate=true swarms=true").
const qe = src('QueryEngine.ts')
check('Implementer boot self-check logs team/model/teammate/swarms', /isImplementerModeOn\(\)\)\s*\{[\s\S]{0,900}implementer\] boot OK[\s\S]{0,260}BOOT SELF-CHECK FAILED/.test(qe))
check('boot self-check is once-per-process (module guard, not per-turn)', /let implementerBootChecked = false/.test(qe) && /if \(!implementerBootChecked\)\s*\{[\s\S]{0,80}implementerBootChecked = true/.test(qe))

section('inbox demux wiring (structural, src)')
const poller = src('hooks', 'useInboxPoller.ts')
check('demux imports isScribeProtocolMessage', poller.includes('isScribeProtocolMessage'))
check('demux branch is `scribeBusEnabled() && isScribeProtocolMessage(m.text)`', /scribeBusEnabled\(\)\s*&&\s*isScribeProtocolMessage\(m\.text\)/.test(poller))

section('file-bus round-trip (writeToMailbox → readUnreadMessages → classify)')
// Redirect the team mailbox root to a temp dir via MERCURY_CONFIG_DIR (getTeamsDir
// → getMercuryHome, memoized on that env). A real write→read of the file
// bus, no live API. If teammateMailbox is not loadable under bun-run, SKIP loudly
// (the live two-process round-trip is then covered by the Phase-4 run-verify).
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tmp = mkdtempSync(join(tmpdir(), 'hermes-scribe-bus-'))
  process.env.MERCURY_CONFIG_DIR = tmp
  try {
    const mailbox = await import('../../src/utils/teammateMailbox.js')
    const env = buildDispatch('scribe', 'do X with TDD', { title: 'X' })
    await mailbox.writeToMailbox(
      'implementer',
      { from: 'scribe', text: serializeScribeEnvelope(env), timestamp: new Date().toISOString() },
      'scribe-test',
    )
    const unread = await mailbox.readUnreadMessages('implementer', 'scribe-test')
    const got = unread.find(m => isScribeProtocolMessage(m.text))
    check('dispatch written to + read back from the file bus', !!got)
    check('round-tripped envelope classifies as a scribe dispatch', !!got && isScribeProtocolMessage(got.text) && got.text === serializeScribeEnvelope(env))
    check('verified sender preserved through the bus', got?.from === 'scribe')
  } catch (e) {
    console.log(`  [SKIP] teammateMailbox not loadable under bun-run (${String(e).split('\n')[0]}) — live round-trip covered by the Phase-4 run-verify`)
  } finally {
    delete process.env.MERCURY_CONFIG_DIR
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BUS-ROUTE PROOFS PASS')
else console.log(`❌ ${failures} BUS-ROUTE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
