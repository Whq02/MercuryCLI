#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const { applyPromptToMarkdown } = await import('../../src/tools/web-fetch/fetchContent.ts')
const { AbortError } = await import('../../src/platform/errors/errors.ts')

const fakeMsg = (text: string) => ({ message: { content: [{ type: 'text', text }] } })
const thrower = (msg: string) => async () => {
  throw new Error(msg)
}
const sig = new AbortController().signal

const summariserHint = 'change applyPromptToMarkdown in src/tools/web-fetch/fetchContent.ts'
const reading = (text: string) => `[Model reading of the extracted page, not the page’s own words.]\n\n${text}`
console.log('============================================================')
console.log(' WebFetch summariser — the utility call, then the session model when it differs, then an honest road')
console.log('============================================================')

section('§1 the utility call answers: its summary comes back with no note')
const r1 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { utility: async () => fakeMsg('SUMMARY') as never, withModel: thrower('should not run') as never, utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'opus' })
check('the primary answer is labelled as a reading', r1 === reading('SUMMARY'), `${r1} | ${summariserHint}`)

section("§2 the utility call fails and the session's own model differs (a local helper slot): the session model is the second road")
const r2 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { utility: thrower('the helper slot refused') as never, withModel: async () => fakeMsg('FALLBACK') as never, utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'opus' })
check('the fallback answer is labelled as a reading', r2 === reading('FALLBACK'), `${r2} | ${summariserHint} so a failed utility call falls back to the session model`)

section('§3 both roads fail: the page content comes back with a note that names the road')
const r3 = await applyPromptToMarkdown('q', 'PAGE CONTENT', sig, true, false, { utility: thrower('helper refused') as never, withModel: thrower('opus refused') as never, utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'opus' })
check('the note says no summariser was available', r3.includes('no summariser model was available'), `${r3} | ${summariserHint}`)
check('the note names both roads it took', r3.includes('Road: tried the utility model local/qwen3.5-2b (helper refused), then the session model opus (opus refused)'), `${r3} | ${summariserHint}`)
check('the page content is delivered under the note', r3.trimEnd().endsWith('PAGE CONTENT'), `${r3} | ${summariserHint}`)
check('a non-preapproved domain keeps the quote ceiling in the note', r3.includes('keep every quotation under 125 characters'), `${r3} | ${summariserHint}`)

section('§4 the session model equals the utility model (every road but a local helper slot): one road, no invented second')
const r4 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { utility: thrower('refused') as never, withModel: thrower('should not run') as never, utilityModelId: () => 'm', mainModelId: () => 'm' })
check('the note says the session model is the same, no second road', r4.includes('the session model is the same, so there was no second road') && !r4.includes('should not run'), `${r4} | ${summariserHint}`)

section('§5 a preapproved domain carries no quote ceiling in the note')
const r5 = await applyPromptToMarkdown('q', 'PAGE', sig, true, true, { utility: thrower('x') as never, withModel: thrower('y') as never, utilityModelId: () => 'a', mainModelId: () => 'b' })
check('the preapproved note omits the quote ceiling', !r5.includes('keep every quotation'), `${r5} | ${summariserHint}`)

section('§6 an aborted signal throws, never a degraded note')
const ac = new AbortController()
ac.abort()
let threw = false
try {
  await applyPromptToMarkdown('q', 'PAGE', ac.signal, true, false, { utility: async () => fakeMsg('x') as never, withModel: thrower('y') as never, utilityModelId: () => 'a', mainModelId: () => 'b' })
} catch (e) {
  threw = e instanceof AbortError
}
check('the abort throws AbortError', threw, `${summariserHint} so an aborted signal throws AbortError and never returns a note`)

section('§8 the first leg answers an API error message, not a throw: a failed leg, and the session model is asked')
const errMsg = (text: string) => ({ isApiErrorMessage: true, message: { content: [{ type: 'text', text }] } })
const REFUSAL = "API Error: model 'gpt-5.4-mini' is not offered by the ChatGPT pro subscription live catalogue. The catalogue offers: gpt-6-astra, gpt-5.6-sol."
const r8 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { utility: async () => errMsg(REFUSAL) as never, withModel: async () => fakeMsg('FALLBACK') as never, utilityModelId: () => 'gpt-5.4-mini', mainModelId: () => 'gpt-5.6-sol' })
check('the refusal is never returned as the reading; the fallback answer is', r8 === reading('FALLBACK'), `${r8} | ${summariserHint} so a leg answering isApiErrorMessage counts as failed`)

section('§9 both legs answer API error messages: the page with the note naming both roads and both reasons')
const r9 = await applyPromptToMarkdown('q', 'PAGE CONTENT', sig, true, false, { utility: async () => errMsg('API Error: helper refused') as never, withModel: async () => errMsg('API Error: session refused') as never, utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'opus' })
check('the note names both roads with the error words as the reasons', r9.includes('Road: tried the utility model local/qwen3.5-2b (API Error: helper refused), then the session model opus (API Error: session refused)'), `${r9} | ${summariserHint}`)
check('the page content is delivered under the note', r9.trimEnd().endsWith('PAGE CONTENT'), `${r9} | ${summariserHint}`)

section('§10 a thrown first leg, then an API error message on the fallback: the note carries each road its own reason')
const r10 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { utility: thrower('helper refused') as never, withModel: async () => errMsg('API Error: session refused') as never, utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'opus' })
check('the thrown reason and the error-message reason sit on their own roads', r10.includes('Road: tried the utility model local/qwen3.5-2b (helper refused), then the session model opus (API Error: session refused)'), `${r10} | ${summariserHint}`)

section('§11 the marker decides, never the words: a true answer that quotes an error line is the summary')
const QUOTING = 'API Error: the page quotes this line as an example, and it is the summary'
const r11 = await applyPromptToMarkdown('q', 'PAGE', sig, true, false, { utility: async () => fakeMsg(QUOTING) as never, withModel: thrower('should not run') as never, utilityModelId: () => 'local/qwen3.5-2b', mainModelId: () => 'opus' })
check('an unmarked reply is a labelled reading, whatever its words', r11 === reading(QUOTING), `${r11} | ${summariserHint} so only the isApiErrorMessage marker, never the words, marks a failed leg`)


console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
