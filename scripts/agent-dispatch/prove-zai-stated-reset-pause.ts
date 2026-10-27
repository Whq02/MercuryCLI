#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
const HOME = mkdtempSync(join(tmpdir(), 'zai-stated-reset-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const zai = await import('../../src/services/providers/zai/zaiClient.ts')
const { compatFaultToTypedError } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { providerWaitIsWindow, stampProviderWait } = await import('../../src/services/api/recoveryBudget.ts')
const pause = await import('../../src/tasks/LocalAgentTask/agentPause.ts')
const lane = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')
import type { Message } from '../../src/types/message.ts'

const statedResetWaitMs: (message: string, nowMs: number) => number | undefined =
  (zai as { zaiStatedResetWaitMs?: (message: string, nowMs: number) => number | undefined }).zaiStatedResetWaitMs ?? (() => undefined)
const mapFailure = (status: number, body: unknown, headers: { get(name: string): string | null } | undefined, nowMs: number) =>
  (zai.mapZaiHttpFailure as (status: number, body: unknown, headers?: { get(name: string): string | null }, nowMs?: number) => ReturnType<typeof zai.mapZaiHttpFailure>)(status, body, headers, nowMs)

const pad = (n: number): string => String(n).padStart(2, '0')
const beijingClock = (atMs: number): string => {
  const shifted = new Date(atMs + 8 * 60 * 60 * 1000)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
}
const MINUTE = 60_000
const HOUR = 60 * MINUTE

section("§1 the sentence names the reset in Beijing time; the wait is the distance to it")
{
  const paused = Date.UTC(2026, 9, 27, 1, 25, 50)
  const sentence = 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 10:19:11'
  check('the Heroes session\'s 1308 body (paused 01:25:50Z, reset 10:19:11 Beijing) waits until 02:19:11Z — 53m21s', statedResetWaitMs(sentence, paused) === 53 * MINUTE + 21_000, String(statedResetWaitMs(sentence, paused)))
  check('the weekly form (1310) parses the same way', statedResetWaitMs('Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-28 08:00:00', paused) === Date.UTC(2026, 9, 28, 0, 0, 0) - paused)
  check('the "Resets at" form (1316–1321) parses too', statedResetWaitMs('Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-10-27 10:19:11.', paused) === 53 * MINUTE + 21_000)
  check('a reset already behind the clock names no wait', statedResetWaitMs('Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 09:00:00', paused) === undefined)
  check('a reset further away than the window the sentence names is not trusted', statedResetWaitMs('Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 20:19:11', paused) === undefined)
  check('a body without the sentence names no wait', statedResetWaitMs('Rate limit reached for requests', paused) === undefined && statedResetWaitMs('Insufficient balance or no resource package. Please recharge.', paused) === undefined)
}

section('§2 the fault carries the stated reset as the provider\'s asked wait when no Retry-After header rides')
{
  const now = Date.UTC(2026, 9, 27, 1, 25, 50)
  const body = { error: { code: 1308, message: 'Usage limit reached for 5 hour. Your limit will reset at 2026-10-27 10:19:11' } }
  const fault = mapFailure(429, body, undefined, now)
  check('the fault is the typed 1308 rate limit', fault.code === 'zai-1308' && fault.status === 429 && compatFaultToTypedError(fault) === 'rate_limit', JSON.stringify(fault))
  check('its asked wait is the stated reset', fault.retryAfterMs === 53 * MINUTE + 21_000, String(fault.retryAfterMs))
  check('a 53-minute wait is the usage window under the retry budget (never slept inside the turn; the crewmate pauses on it)', providerWaitIsWindow(fault.retryAfterMs))
  const headed = mapFailure(429, body, { get: name => (name === 'retry-after' ? '30' : null) }, now)
  check('a Retry-After header still outranks the sentence', headed.retryAfterMs === 30_000, String(headed.retryAfterMs))
  const burst = mapFailure(429, { error: { code: 1302, message: 'Rate limit reached for requests' } }, undefined, now)
  check('a burst refusal without a reset carries no asked wait', burst.retryAfterMs === undefined)
}

section('§3 the paused crewmate\'s row names the reset it already knew how to name')
{
  const now = Date.now()
  const resetAt = now + 53 * MINUTE + 21_000
  const sentence = `Usage limit reached for 5 hour. Your limit will reset at ${beijingClock(resetAt)}`
  const fault = mapFailure(429, { error: { code: 1308, message: sentence } }, undefined, now)
  const row = stampProviderWait(
    createAssistantAPIErrorMessage({ content: `API Error: Z.AI is rate-limiting this account (zai-1308: ${sentence}) — retry in a moment, or /model picks another model meanwhile.`, error: 'rate_limit' }),
    fault.retryAfterMs,
    now,
  ) as Message
  const paused = lane.usageWindowPauseOf([row], 'glm-5.3')
  check('the settled row is a usage-limit pause', paused?.why === 'usage limit', JSON.stringify(paused))
  check('the pause resumes by itself at the stated reset', paused?.resumesAtMs !== undefined && Math.abs(paused.resumesAtMs - resetAt) < 2_000, String(paused?.resumesAtMs))
  const words = paused === null ? '' : pause.pauseResumeWords(paused, now)
  check('the row says when it retries by itself, with the countdown', words.startsWith('retries by itself at ') && words.includes('(in 53m)'), words)
  check('the row never says "no reset stated" when the provider stated one', !words.includes('no reset stated'), words)
  const status = paused === null ? '' : pause.pauseStatusWords(paused, now)
  check('the status line carries the pause words, the reset and the resume key', status.startsWith('paused — API Error: Z.AI is rate-limiting this account') && status.includes('retries by itself at') && status.endsWith('· r retries now'), status)
  check('a wait past the budget is never a burst retry inside the turn', providerWaitIsWindow(fault.retryAfterMs) && fault.retryable)
}

section('§4 a body the sentence law does not cover keeps today\'s honest absence')
{
  const now = Date.now()
  const fault = mapFailure(429, { error: { code: 1302, message: 'Rate limit reached for requests' } }, undefined, now)
  const row = stampProviderWait(createAssistantAPIErrorMessage({ content: 'API Error: Z.AI is rate-limiting this account (zai-1302: Rate limit reached for requests)', error: 'rate_limit' }), fault.retryAfterMs, now) as Message
  const paused = lane.usageWindowPauseOf([row], 'glm-5.3')
  const words = paused === null ? '' : pause.pauseResumeWords({ why: paused.why, resumesAtMs: paused.resumesAtMs }, now)
  check('without a stated reset (and no observed window) the row still says so', paused !== null && (paused.resumesAtMs === undefined ? words === 'no reset stated — a message resumes it' : words.startsWith('retries by itself at ')), words)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} zai stated reset pause: ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
