#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) fail++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

console.log('prove-terminal-400 — deterministic 400s are terminal, never retried')

const src = readFileSync(
  join(import.meta.dir, '../../src/tools/WorkflowTool/agentHooks.ts'),
  'utf8',
)

section('(1) the deterministic-400 signature set (extracted from source)')
const m = src.match(/const DETERMINISTIC_400_RE =\s*\n?\s*(\/.+\/i)/)
check('DETERMINISTIC_400_RE declared', m !== null)
let re: RegExp | undefined
if (m) {
  const body = m[1]!
  re = new RegExp(body.slice(1, body.lastIndexOf('/')), 'i')
  for (const s of [
    'Prompt is too long',
    'prompt is too long: 214431 tokens > 204698 maximum',
    'input length exceeds the maximum context length',
    'context window exceeded',
    '{"type":"error","error":{"type":"invalid_request_error","message":"…"}}',
  ]) {
    check(`matches: ${s.slice(0, 56)}`, re.test(s))
  }
  for (const s of [
    'Overloaded',
    'API Error: 529 overloaded_error',
    'Internal server error (500)',
    'rate_limit_error: Number of request tokens has exceeded your per-minute rate limit',
    'Request timed out',
    'connection reset by peer',
  ]) {
    check(`does NOT match transient: ${s.slice(0, 48)}`, !re.test(s))
  }
}

section('(2) wiring source-locks (latch → abort → non-retryable settle)')
check(
  'the assistant branch tests API-error text against the regex',
  /isApiErrorMessage\)\s*\{\s*\n\s*const errText = extractTextContent\(a\.message\.content[\s\S]{0,200}DETERMINISTIC_400_RE\.test\(errText\)/.test(src),
)
check("sighting aborts the attempt with reason 'terminal-400'", src.includes("abortWithCut(childAbort, 'terminal-400')"))
const catchBlock = src.slice(src.indexOf("cutReason === 'terminal-400'"))
check("the catch settles terminal-400 BEFORE the stall/user-retry branch", src.indexOf("cutReason === 'terminal-400'") !== -1 && src.indexOf("cutReason === 'terminal-400'") < src.indexOf("cutReason === 'stalled' || cutReason === 'user-retry'"))
check(
  'the settle is stallCut:false + apiError (the ladder never retries apiError)',
  catchBlock.slice(0, 400).includes('apiErrorSettle(elapsed, terminal400)') &&
    /const apiErrorSettle[\s\S]{0,500}apiError: message,[\s\S]{0,160}stallCut: false,\s*\n\s*skipped: false,/.test(src),
)
check(
  'the outer ladder gates stall retries on report.stallCut (apiError bypasses it)',
  src.includes('for (let a = 1; report.stallCut && !tookThrottleRescue'),
)
check(
  'looksThrottled refuses DETERMINISTIC-400 and provider-throttled apiError results (the natural-settle race)',
  /const looksThrottled = \(r: \w+\): boolean =>\s*\n\s*(?:r\.capPause === undefined &&\s*\n\s*)?\(r\.apiError === undefined \|\|\s*\n\s*\(!DETERMINISTIC_400_RE\.test\(r\.apiError\) &&\s*\n\s*!isRecoveryBudgetSpentLine\(r\.apiError\)\)\) &&/.test(src),
)
if (re) {
  const detRe = re
  const detector = (r: { apiError?: string; stalled: boolean; skipped: boolean; stopReason: string | null; structured?: unknown; outputTokens?: number; durationMs: number }, stallMs: number): boolean =>
    (r.apiError === undefined || !detRe.test(r.apiError)) && !r.stalled && !r.skipped && r.stopReason == null && r.structured === undefined && (r.outputTokens ?? Infinity) < 50 && r.durationMs > stallMs * 0.5
  const base = { stalled: false, skipped: false, stopReason: null, structured: undefined, outputTokens: 0, durationMs: 100_000 }
  check('terminal-400 shape NOT throttled', detector({ ...base, apiError: 'Prompt is too long' }, 180_000) === false)
  check('TRANSIENT apiError shape keeps the throttle rescue', detector({ ...base, apiError: 'API Error: 529 overloaded_error' }, 180_000) === true)
  check('legit degraded shape still throttles', detector(base, 180_000) === true)
}
check(
  'terminal-400 abort path rescues delivered structured output',
  /cutReason === 'terminal-400' && terminal400\) \{\s*\n\s*return structured !== undefined\s*\n\s*\? deliveredSettle\(elapsed\)\s*\n\s*: apiErrorSettle\(elapsed, terminal400\)/.test(src),
)
check(
  'natural stream-end route carries the same delivered-output-wins guard',
  /lastAssistant\?\.isApiErrorMessage\) \{[\s\S]{0,300}if \(structured !== undefined\)/.test(src),
)
check(
  "the watchdog-race branch settles a latched terminal400 as apiError (never 'stalled')",
  /cutReason === 'stalled' \|\| cutReason === 'user-retry'\) \{(?:(?!emitFrame\()[\s\S]){0,900}if \(terminal400\) return apiErrorSettle\(elapsed, terminal400\)\s*emitFrame\('error'/.test(src),
)

section('(3) dist bundle carries the latch (rename/DCE guard)')
try {
  const dist = readFileSync(join(import.meta.dir, '../../dist/mercury.mjs'), 'utf8')
  check("dist contains the 'terminal-400' abort reason", dist.includes('terminal-400'))
  check('dist contains the regex body (maximum context length)', dist.includes('maximum context length'))
} catch {
  check('dist/mercury.mjs readable (build before gating)', false)
}

console.log(fail === 0 ? '\n✅ prove-terminal-400: ALL PASS' : `\n❌ prove-terminal-400: ${fail} FAILURE(S)`)
process.exit(fail === 0 ? 0 : 1)
