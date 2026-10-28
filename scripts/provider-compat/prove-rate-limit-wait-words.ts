#!/usr/bin/env bun
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '20'
delete process.env.MERCURY_HOME

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { compatTerminalFaultText } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { mapZaiHttpFailure, zaiStatedResetWaitMs } = await import('../../src/services/providers/zai/zaiClient.ts')

const profile = { providerLabel: 'Gemini', credentialHint: 'hint' }
const ZAI_FAULT_PROFILE = { providerLabel: 'Z.AI', credentialHint: 'hint' }
const line = (fault: { code: string; message: string; retryAfterMs?: number; status?: number }): string => compatTerminalFaultText(profile, fault, 'rate_limit')
const GEMINI_MESSAGE = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 78h18m19s.'
const ZAI_MESSAGE = 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 20:34:34'

section('§1 a wait under a minute: the wait is named and "retry in a moment" stands, as before')
{
  const text = line({ code: 'http-429', message: 'slow down', retryAfterMs: 40_000, status: 429 })
  check('40 s', text === 'API Error: Gemini is rate-limiting this account (http-429: slow down) — the provider asks for a 40 s wait — retry in a moment, or /model picks another model meanwhile.', text)
}

section('§2 a wait of a minute or more inside the retry budget: the sentence names the wait and keeps the /model door; "retry in a moment" is gone')
{
  const text = line({ code: 'http-429', message: 'slow down', retryAfterMs: 12 * 60_000, status: 429 })
  check('12 min', text === 'API Error: Gemini is rate-limiting this account (http-429: slow down) — the provider asks for a 12 min wait, or /model picks another model meanwhile.', text)
}

section('§3 a wait past the retry budget (the provider\'s window): the pause clause stands, the /model door follows it; the session\'s 78 h 18 m Gemini row')
{
  const fault = mapCompatHttpFailure(429, { error: { code: 429, message: GEMINI_MESSAGE, status: 'RESOURCE_EXHAUSTED' } }, new Headers({ 'retry-after': '281900' }))
  const text = line(fault)
  check('the session row, re-spelled', text === `API Error: Gemini is rate-limiting this account (api-RESOURCE_EXHAUSTED: rate limited (provider asks for 3 d 6 h): ${GEMINI_MESSAGE}) — the provider asks for a 3 d 6 h wait, past the retry budget: a dispatched crewmate pauses until then, or /model picks another model meanwhile.`, text)
  check('the row never says "retry in a moment" beside a wait of days', !text.includes('retry in a moment'))
  const hours = line({ code: 'http-429', message: 'quota', retryAfterMs: 3 * 3_600_000 + 6 * 60_000, status: 429 })
  check('3 h 6 min', hours === 'API Error: Gemini is rate-limiting this account (http-429: quota) — the provider asks for a 3 h 6 min wait, past the retry budget: a dispatched crewmate pauses until then, or /model picks another model meanwhile.', hours)
}

section('§4 the Z.AI window: the reset the body states becomes the wait the row names; a reset the road cannot time is named in the provider\'s own words')
{
  const now = Date.UTC(2026, 9, 27, 8, 0, 0)
  const fault = mapZaiHttpFailure(429, { error: { code: 1308, message: ZAI_MESSAGE } }, undefined, now)
  check('the stated reset (Beijing time) is the wait', fault.retryAfterMs === zaiStatedResetWaitMs(ZAI_MESSAGE, now) && fault.retryAfterMs === 4 * 3_600_000 + 34 * 60_000 + 34_000, String(fault.retryAfterMs))
  const text = compatTerminalFaultText(ZAI_FAULT_PROFILE, fault, 'rate_limit')
  check('the Z.AI row names the wait', text === `API Error: Z.AI is rate-limiting this account (zai-1308: ${ZAI_MESSAGE}) — the provider asks for a 4 h 35 min wait, past the retry budget: a dispatched crewmate pauses until then, or /model picks another model meanwhile.`, text)
  const untimed = compatTerminalFaultText(ZAI_FAULT_PROFILE, { code: 'zai-1308', message: ZAI_MESSAGE, status: 429 }, 'rate_limit')
  check('with no wait on the fault, the row names the reset the message carries', untimed === `API Error: Z.AI is rate-limiting this account (zai-1308: ${ZAI_MESSAGE}) — the provider says the limit resets at 2026-10-27 20:34:34, or /model picks another model meanwhile.`, untimed)
  const relative = line({ code: 'api-QUOTA_EXHAUSTED', message: GEMINI_MESSAGE, status: 429 })
  check('a "resets in" sentence is named the same way', relative === `API Error: Gemini is rate-limiting this account (api-QUOTA_EXHAUSTED: ${GEMINI_MESSAGE}) — the provider says the limit resets in 78h18m19s, or /model picks another model meanwhile.`, relative)
}

section('§5 no wait and no stated reset: the sentence is unchanged')
{
  const text = line({ code: 'http-429', message: 'Rate limit exceeded. Please try again later.', status: 429 })
  check('a plain 429', text === 'API Error: Gemini is rate-limiting this account (http-429: Rate limit exceeded. Please try again later.) — retry in a moment, or /model picks another model meanwhile.', text)
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-rate-limit-wait-words: ALL LAWS HOLD' : `prove-rate-limit-wait-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

export {}
