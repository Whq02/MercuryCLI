#!/usr/bin/env bun
import fc from 'fast-check'
import { findTokenBudgetPositions } from '../../src/screen/composer/tokenBudgetMentions.ts'

const WHERE = 'findTokenBudgetPositions in src/screen/composer/tokenBudgetMentions.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const spans = (text: string): string => findTokenBudgetPositions(text).map(span => `${span.start}-${span.end}`).join(' ')
const expectSpans = (name: string, text: string, want: string): void => check(`${name}: ${JSON.stringify(text)}`, spans(text) === want, `got [${spans(text)}], expected [${want}]; see ${WHERE}`)

section('§1 no budget in the text')
{
  expectSpans('an empty text', '', '')
  expectSpans('plain words', 'plain words', '')
  expectSpans('a plus sign apart from its number', '+ 5k', '')
  expectSpans('a unit that is not k, m or b', '+1x', '')
  expectSpans('a unit that runs on into a word', '+5kb', '')
  expectSpans('a short form in the middle of the text', 'x +1k y', '')
  expectSpans('a short form glued to the word before it', 'do it+10k', '')
  expectSpans('a count with no unit', 'use 2 tokens', '')
  expectSpans('a verb that is only the tail of another word', 'reuse 2k tokens', '')
}

section('§2 the short form at the start')
{
  expectSpans('a number and a unit after a plus', '+500k do it', '0-5')
  expectSpans('alone', '+3k', '0-3')
  expectSpans('the unit b', '+1b', '0-3')
  expectSpans('leading spaces are not part of the span', '  +2.5m x', '2-7')
  expectSpans('a space between number and unit is part of it', '+5 k', '0-4')
  expectSpans('punctuation after the unit is not', '+5k.', '0-3')
}

section('§3 the short form at the end')
{
  expectSpans('after a space, at the very end', 'do it +10k', '6-10')
  expectSpans('a closing full stop belongs to the span', 'do it +10k.', '6-11')
  expectSpans('so do a question mark', 'do it +10k?', '6-11')
  expectSpans('and an exclamation mark with the spaces after it', 'do it +10k!  ', '6-13')
  expectSpans('one at the start and one at the end are two spans, start first, in either case of the unit', '+1B and more +2M', '0-3 13-16')
  expectSpans('two short forms and nothing else', '+1k +2k', '0-3 4-7')
}

section('§4 the long form, anywhere')
{
  expectSpans('use, a number with its unit, tokens', 'please use 2m tokens here', '7-20')
  expectSpans('spend, with spaces before the unit and the singular token', 'spend 500 k token', '0-17')
  expectSpans('with no space before tokens', 'spend 2ktokens', '0-14')
  expectSpans('every occurrence, in any case', 'Use 1.5B TOKENS and use 3k tokens', '0-15 20-33')
  expectSpans('all three forms together: the start, then the end, then the long forms in their order', '+7k then use 8k tokens then +9k', '0-3 28-31 9-22')
}

section('§5 the laws, on generated texts')
{
  const within = fc.check(fc.property(fc.string(), text => findTokenBudgetPositions(text).every(span => Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.start < span.end && span.end <= text.length)), { numRuns: 1000 })
  check('every span lies inside the text and is not empty', !within.failed, `counterexample ${JSON.stringify(within.counterexample)}; see ${WHERE}`)
  const amount = fc.tuple(fc.integer({ min: 1, max: 9999 }), fc.constantFrom('k', 'm', 'b', 'K', 'M', 'B'))
  const words = fc.stringMatching(/^[a-z]{1,8}( [a-z]{1,8}){0,4}$/)
  const lead = fc.check(fc.property(amount, words, ([number, unit], tail) => spans(`+${number}${unit} ${tail}`) === `0-${`+${number}${unit}`.length}`), { numRuns: 500 })
  check('a short form followed by plain words is found at the start, exactly as long as it is written', !lead.failed, `counterexample ${JSON.stringify(lead.counterexample)}; see ${WHERE}`)
  const trail = fc.check(fc.property(words, amount, (head, [number, unit]) => spans(`${head} +${number}${unit}`) === `${head.length + 1}-${head.length + 1 + `+${number}${unit}`.length}`), { numRuns: 500 })
  check('plain words followed by a short form: it is found at the end, from its plus sign', !trail.failed, `counterexample ${JSON.stringify(trail.counterexample)}; see ${WHERE}`)
  const none = fc.check(fc.property(fc.stringMatching(/^[a-z .,]{0,60}$/), text => /\b(?:use|spend)\b/.test(text) || spans(text) === ''), { numRuns: 500 })
  check('a text with no plus sign and neither verb has no span', !none.failed, `counterexample ${JSON.stringify(none.counterexample)}; see ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-token-budget-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-token-budget-behaviour: all green')
