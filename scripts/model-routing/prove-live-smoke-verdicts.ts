#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agenticVerdict, imageVerdict, latchVerdict, turnAnswerVerdict } from './live/smokeVerdicts.ts'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const reason = (v: { ok: boolean; reason?: string }): string => (v.ok ? 'ok' : v.reason ?? '')

console.log('[1] the agentic verdict')
{
  const good = agenticVerdict({ finalText: 'The result is 676.571428…', turnsUsed: 4, maxTurns: 8, reasoningRecordedBeforeLastRequest: 3, reasoningReplayedInLastRequest: 3, expected: '676.57' })
  check('a real final answer after tool turns with reasoning replayed into the last request is green', good.ok)
  const exhausted = agenticVerdict({ finalText: null, turnsUsed: 8, maxTurns: 8, reasoningRecordedBeforeLastRequest: 7, reasoningReplayedInLastRequest: 7, expected: '676.57' })
  check('eight turns that all requested tools are red even with reasoning counted', !exhausted.ok && /no final answer/.test(reason(exhausted)), reason(exhausted))
  const apiError = agenticVerdict({ finalText: 'API Error: 429 rate limit exceeded; the value 676.57 was not computed', turnsUsed: 2, maxTurns: 8, reasoningRecordedBeforeLastRequest: 1, reasoningReplayedInLastRequest: 1, expected: '676.57' })
  check('an API error that happens to mention the expected number is red', !apiError.ok && /API error/.test(reason(apiError)), reason(apiError))
  const wrong = agenticVerdict({ finalText: 'The result is 700', turnsUsed: 3, maxTurns: 8, reasoningRecordedBeforeLastRequest: 2, reasoningReplayedInLastRequest: 2, expected: '676.57' })
  check('a wrong final answer is red', !wrong.ok && /wrong final answer/.test(reason(wrong)), reason(wrong))
  const noReplay = agenticVerdict({ finalText: 'The result is 676.571', turnsUsed: 1, maxTurns: 8, reasoningRecordedBeforeLastRequest: 0, reasoningReplayedInLastRequest: 0, expected: '676.57' })
  check('a first-turn answer with nothing recorded before it proves no replay and is red', !noReplay.ok && /replay is unproven/.test(reason(noReplay)), reason(noReplay))
  const dropped = agenticVerdict({ finalText: 'The result is 676.571', turnsUsed: 3, maxTurns: 8, reasoningRecordedBeforeLastRequest: 2, reasoningReplayedInLastRequest: 0, expected: '676.57' })
  check('reasoning recorded but absent from the final request is red', !dropped.ok && /replayed no earlier reasoning/.test(reason(dropped)), reason(dropped))
  const decimals = agenticVerdict({ finalText: 'Computed 4736 / 7 = 676.571 (about 500 more than 176.571)', turnsUsed: 3, maxTurns: 8, reasoningRecordedBeforeLastRequest: 2, reasoningReplayedInLastRequest: 2, expected: '676.57' })
  check('three-digit fragments of a real answer are not mistaken for HTTP statuses', decimals.ok, reason(decimals))
  const status = agenticVerdict({ finalText: 'Request failed with status 503; partial: 676.571', turnsUsed: 3, maxTurns: 8, reasoningRecordedBeforeLastRequest: 2, reasoningReplayedInLastRequest: 2, expected: '676.57' })
  check('a status line without the API Error prefix is still red', !status.ok && /API error/.test(reason(status)), reason(status))
}

console.log('[2] the image verdict')
{
  check('"Red" is green', imageVerdict('Red').ok)
  check('"The image is solid red." is green', imageVerdict('The image is solid red.').ok)
  const required = imageVerdict('API Error: image input required a valid key; token expired')
  check('an error mentioning required and expired is red', !required.ok && /API error/.test(reason(required)), reason(required))
  const denial = imageVerdict('The image is not red, it is blue.')
  check('"not red" is red', !denial.ok && /denies red/.test(reason(denial)), reason(denial))
  const other = imageVerdict('Blue')
  check('an answer that never names red is red', !other.ok, reason(other))
  check('an empty answer is red', !imageVerdict('').ok)
}

console.log('[3] the turn verdict')
{
  check('"17 + 25 = 42" is green', turnAnswerVerdict('17 + 25 = 42', '42').ok)
  const status = turnAnswerVerdict('API Error: 429 Too Many Requests (retry after 42s)', '42')
  check('a 429 error carrying the digits is red', !status.ok && /API error/.test(reason(status)), reason(status))
  const embedded = turnAnswerVerdict('The answer is 1742.', '42')
  check('42 inside another number is red', !embedded.ok && /as a number/.test(reason(embedded)), reason(embedded))
  check('an empty answer is red', !turnAnswerVerdict('', '42').ok)
}

console.log('[4] the readiness latch verdict')
{
  check('a latch that flipped during this run for this model is green', latchVerdict(null, { at: 200, model: 'gpt-5.6-sol' }, 'gpt-5.6-sol').ok)
  const absent = latchVerdict(null, null, 'gpt-5.6-sol')
  check('an absent latch is red', !absent.ok && /never flipped/.test(reason(absent)), reason(absent))
  const stale = latchVerdict({ at: 200 }, { at: 200, model: 'gpt-5.6-sol' }, 'gpt-5.6-sol')
  check('a latch already set before the run and unchanged after it is red', !stale.ok && /predates this run/.test(reason(stale)), reason(stale))
  const later = latchVerdict({ at: 200 }, { at: 350, model: 'gpt-5.6-sol' }, 'gpt-5.6-sol')
  check('a latch set earlier and set again during the run is green', later.ok)
  const other = latchVerdict(null, { at: 200, model: 'gpt-5.4' }, 'gpt-5.6-sol')
  check('a latch naming another model is red', !other.ok && /names gpt-5.4/.test(reason(other)), reason(other))
}

console.log('[5] the live scripts consult the verdicts, never a bare substring')
{
  const live = (name: string): string => readFileSync(join(import.meta.dir, 'live', name), 'utf8')
  const agentic = live('smoke-agentic.ts')
  check('smoke-agentic decides through agenticVerdict with the replay observed on the final request', agentic.includes('agenticVerdict({') && agentic.includes('reasoningReplayedInLastRequest: replayedInLastRequest') && !agentic.includes("if (reasoningReplayed === 0) {"))
  const image = live('smoke-image.ts')
  check('smoke-image decides through imageVerdict, never /red/i alone', image.includes('imageVerdict(text)') && !image.includes('if (!/red/i.test(text))'))
  const turn = live('smoke-turn.ts')
  check('smoke-turn decides the answer through turnAnswerVerdict and the latch against its pre-run state', turn.includes("turnAnswerVerdict(t2Text, '42')") && turn.includes('latchVerdict(latchBefore, proof, MODEL)') && !turn.includes("if (!t2Text.includes('42'))"))
}

if (failures > 0) {
  console.log(`\nprove-live-smoke-verdicts: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-live-smoke-verdicts: green')
