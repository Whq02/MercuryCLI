#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
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
const composer = read('src/components/PromptInput/PromptInput.tsx')
check('the composer cuts only on the compact layouts, one column in from the width, and paints the cut body in a fixed-width box with the end cut and the tail beside it', composer.includes('const capLaneCut = capLaneLine !== null && isCompact ? capLaneLineCut(capLaneLine, columns - 1) : null') && composer.includes('<Box width={capLaneCut.bodyColumns} flexShrink={0} minWidth={0}>') && composer.includes('<Text color={AMBER} wrap="truncate-end">{capLaneCut.body}</Text>') && composer.includes('<Text color={AMBER}>{capLaneCut.tail}</Text>'))
check('a wide layout paints the sentence as before', composer.includes('<Text color={AMBER}>{capLaneLine}</Text>'))

console.log('§3 the compact band: the ready word waits for the session to land')
check('idle with a session on the slot reads ready', band.compactBandIdle(false, false))
check('a turn in flight reads no ready word, as before', !band.compactBandIdle(true, false))
check('a landing with no session on the slot yet reads no ready word', !band.compactBandIdle(false, true))
const source = read('src/components/CompactIdentityBand.tsx')
check('the band reads the landing gate and the empty slot together, through the slot\'s own subscription', source.includes('const getFocusedLanding = (): boolean => landingInFlight() && !hasFocusedSession()') && source.includes('useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedLanding, getFocusedLanding)') && source.includes('const idle = compactBandIdle(inFlight, landing)'))
check('the dot, the separator and the word all follow the one idle fact', source.includes('{idle ? <Text color={tok.success}> ready</Text> : null}') && source.includes('{idle ? <Box flexShrink={0}><BreathingDot /></Box> : null}') && source.includes('{idle ? <Text color={tok.textMuted}> · </Text> : null}'))

console.log(`\n${failures === 0 ? '✅' : '❌'} failover-compact-rows — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
