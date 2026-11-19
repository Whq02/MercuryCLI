#!/usr/bin/env bun
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const cap = await import('../../src/services/capFailover.ts')
const band = await import('../../src/components/CompactIdentityBand.tsx')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')

const facts = { lane: 'anthropic', modelName: 'Fable 5.1', homeName: 'OpenAI', homeWindow: { state: 'rejected' as const }, resetText: '4:01am' } as unknown as Parameters<typeof cap.capLaneLineWords>[0]
const words = cap.capLaneLineWords(facts)

console.log('§1 the sentence: one body, one tail, the words unchanged')
check('the whole sentence reads as before', words === 'on the anthropic failover lane · Fable 5.1 · OpenAI window resets 4:01am · /model to return', words)
check('the body is the sentence without its tail', cap.capLaneLineBody(facts) + cap.CAP_LANE_LINE_TAIL === words)
check('the tail is the way home', cap.CAP_LANE_LINE_TAIL === ' · /model to return')

console.log('§2 the cut at a narrow row: the body yields with an ellipsis, the tail keeps the row\'s end')
const cut = cap.capLaneLineCut(words, 79)
check('80 columns (79 after the padding): the sentence is wider than the row, so it is cut', cut !== null, JSON.stringify(cut))
check('the cut hands the body the columns left after the tail', cut !== null && cut.tail === ' · /model to return' && cut.bodyColumns === 79 - stringWidth(' · /model to return') && cut.body === cap.capLaneLineBody(facts), JSON.stringify(cut))
check('a row wide enough for the whole sentence is not cut (120 columns as before)', cap.capLaneLineCut(words, 119) === null)
check('a sentence exactly as wide as the row is not cut', cap.capLaneLineCut(words, stringWidth(words)) === null)
check('a sentence without the tail is left alone', cap.capLaneLineCut('on the anthropic failover lane · Fable 5.1', 20) === null)

console.log('§3 the compact band: the ready word waits for the session to land')
check('idle with a session on the slot reads ready', band.compactBandIdle(false, false))
check('a turn in flight reads no ready word, as before', !band.compactBandIdle(true, false))
check('a landing with no session on the slot yet reads no ready word', !band.compactBandIdle(false, true))

console.log(`\n${failures === 0 ? '✅' : '❌'} failover-compact-rows — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
