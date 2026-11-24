#!/usr/bin/env bun
import { join } from 'node:path'

import { scanTailForEndedOnError } from '../../src/sessions/transcripts/sessionStoragePortable.js'
import { formatListingMetadata } from '../../src/platform/text/format.js'
import { entryToRecord } from '../../src/sessions/fabric/entryCodec.js'
import { ordinalOf } from '../../src/sessions/fabric/ordinal.js'

let __ord = 0
const enc = (entry: unknown): string =>
  JSON.stringify(
    entryToRecord(entry as never, {
      sessionId: 'sess-1',
      nextOrdinal: () => ordinalOf(++__ord),
      observedAt: '2026-01-01T10:00:00.000Z',
      source: { channel: 'interactive' },
    } as never),
  )

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const endedOnErrorHint = /^(endedOnError|marker)/.test(label)
    ? 'fix formatLogMetadata in src/platform/text/format.ts: the last part is the ended-on-error marker, added only when endedOnError is true'
    : 'fix scanTailForEndedOnError in src/sessions/transcripts/sessionStoragePortable.ts: the last real assistant or api_error line rules, quoted or nested error-shaped text never counts, and an unreadable tail gives undefined'
  const shown = cond ? detail : detail ? `${detail} — ${endedOnErrorHint}` : endedOnErrorHint
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' resume-picker end-state — ended-on-error tail scan')
console.log('============================================================')

let seq = 0
const uid = () => `u-${seq++}`
const stamp = {
  parentUuid: null as string | null,
  isSidechain: false,
  cwd: '/tmp/x',
  sessionId: 'sess-1',
  version: '1.0.0-beta.1',
  gitBranch: 'main',
}
const asstLine = (opts: { error?: string; apiErr?: boolean; text?: string } = {}): string =>
  enc({
    ...stamp,
    type: 'assistant',
    uuid: uid(),
    timestamp: '2026-01-01T10:00:00.000Z',
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.apiErr ? { isApiErrorMessage: true } : {}),
    message: { id: uid(), role: 'assistant', content: [{ type: 'text', text: opts.text ?? 'done' }] },
    requestId: 'req-1',
  })
const userLine = (content: unknown): string =>
  enc({
    ...stamp,
    type: 'user',
    uuid: uid(),
    timestamp: '2026-01-01T10:01:00.000Z',
    message: { role: 'user', content },
  })
const sysApiErrorLine = (): string =>
  enc({
    ...stamp,
    type: 'system',
    subtype: 'api_error',
    uuid: uid(),
    timestamp: '2026-01-01T10:02:00.000Z',
    content: 'API error: overloaded (retrying)',
  })
const awaySummaryLine = (): string =>
  enc({
    ...stamp,
    type: 'system',
    subtype: 'away_summary',
    uuid: uid(),
    timestamp: '2026-01-01T10:03:00.000Z',
    content: 'Resumed — prior run ended on an error, 3 turns',
    recapMetadata: { endedOnError: true, turns: 3 },
  })
const metaLines = [
  JSON.stringify({ type: 'summary', leafUuid: 'leaf-1', summary: 'a summary' }),
  JSON.stringify({ type: 'custom-title', sessionId: 'sess-1', customTitle: 'my session' }),
]
const T = (...lines: string[]) => lines.join('\n') + '\n'

section('(a) end-state verdicts — the LAST assistant/api_error line rules')
{
  check('error-field last assistant ⇒ true', scanTailForEndedOnError(T(userLine([{ type: 'text', text: 'go' }]), asstLine({ error: 'server_error' }))) === true)
  check('isApiErrorMessage last assistant ⇒ true', scanTailForEndedOnError(T(asstLine(), asstLine({ apiErr: true }))) === true)
  check('clean last assistant ⇒ false', scanTailForEndedOnError(T(asstLine({ error: 'rate_limit' }), asstLine(), userLine([{ type: 'text', text: 'thanks' }]))) === false)
  check('recovered: clean assistant AFTER an errored one ⇒ false', scanTailForEndedOnError(T(asstLine({ apiErr: true }), userLine([{ type: 'text', text: 'retry' }]), asstLine())) === false)
  check('persisted system api_error after the last assistant ⇒ true', scanTailForEndedOnError(T(asstLine(), sysApiErrorLine())) === true)
  check('trailing metadata entries do not mask the verdict', scanTailForEndedOnError(T(asstLine({ error: 'server_error' }), ...metaLines)) === true)
}

section('(b) spoof-safety — quoted/nested error-shaped literals never rule')
{
  const nestedSpoof = userLine([
    { type: 'tool_result', tool_use_id: 'x', content: 'ok' },
    { type: 'text', text: 'payload follows' },
  ]).replace('"payload follows"', '"p","spoof":{"type":"assistant","isApiErrorMessage":true}')
  check('nested unescaped spoof line really contains the literal', nestedSpoof.includes('"type":"assistant"'))
  check('nested-JSON spoof after a clean assistant ⇒ false (not spoofed)', scanTailForEndedOnError(T(asstLine(), nestedSpoof)) === false)
  const quotedSpoof = userLine([{ type: 'text', text: 'saw {"type":"assistant","isApiErrorMessage":true} in a log' }])
  check('string-quoted spoof serializes ESCAPED (pre-filter immune)', !quotedSpoof.includes('"type":"assistant"'))
  check('string-quoted spoof after a clean assistant ⇒ false', scanTailForEndedOnError(T(asstLine(), quotedSpoof)) === false)
  const cleanLookingSpoof = userLine([{ type: 'tool_result', tool_use_id: 'y', content: 'ok' }]).replace('"ok"', '"o","spoof":{"type":"assistant","content":"all done"}')
  check('clean-looking nested spoof after an ERRORED assistant ⇒ still true', scanTailForEndedOnError(T(asstLine({ apiErr: true }), cleanLookingSpoof)) === true)
  check('a persisted away_summary recap card (endedOnError:true) ⇒ ignored', scanTailForEndedOnError(T(asstLine(), awaySummaryLine())) === false)
}

section('(c) honest absence — truncated / unparseable / empty tails ⇒ undefined')
{
  check('empty tail ⇒ undefined', scanTailForEndedOnError('') === undefined)
  check('metadata-only tail ⇒ undefined', scanTailForEndedOnError(T(...metaLines)) === undefined)
  const cut = asstLine({ error: 'server_error' }).slice(40)
  check('boundary-truncated lone assistant line ⇒ undefined', cut.includes('"kind":"output"') && scanTailForEndedOnError(T(cut, ...metaLines)) === undefined)
  const midAppend = T(asstLine()).slice(0, -1) + '\n' + asstLine({ apiErr: true }).slice(0, 60)
  check('mid-append truncated error line ⇒ prior complete clean line rules (false)', scanTailForEndedOnError(midAppend) === false)
  check('user-only tail (no assistant in window) ⇒ undefined', scanTailForEndedOnError(T(userLine([{ type: 'text', text: 'hello' }]))) === undefined)
}

section('(d) formatLogMetadata — the ✕ marker is the LAST part, only when true')
{
  const base = { modified: new Date(Date.now() - 3600_000), messageCount: 12, gitBranch: 'main', tag: 'work', prNumber: 7, prRepository: 'o/r' }
  const marked = formatListingMetadata({ ...base, endedOnError: true })
  const unmarkedFalse = formatListingMetadata({ ...base, endedOnError: false })
  const unmarkedAbsent = formatListingMetadata(base)
  console.log(`       → "${marked}"`)
  check('endedOnError: true ⇒ ends with the ✕ marker', marked.endsWith(' · ✕ ended on error'))
  check('marker is the LAST part (after tag + PR)', marked.indexOf('#work') !== -1 && marked.indexOf('✕ ended on error') > marked.indexOf('#work') && marked.indexOf('o/r#7') !== -1 && marked.indexOf('✕ ended on error') > marked.indexOf('o/r#7'))
  check('endedOnError: false ⇒ no marker', !unmarkedFalse.includes('ended on error'))
  check('endedOnError absent ⇒ byte-identical to false', unmarkedAbsent === unmarkedFalse)
}


console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ENDED-ON-ERROR TAIL PROOFS PASS')
else console.log(`❌ ${failures} ENDED-ON-ERROR PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
