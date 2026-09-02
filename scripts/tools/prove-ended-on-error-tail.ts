#!/usr/bin/env bun
// ============================================================================
//  scripts/tools/prove-ended-on-error-tail.ts
//  PROOF: the fork resume-picker end-state (trust-cockpit W2c). readLiteMetadata
//  derives `endedOnError` by scanning the 64KB tail window's JSONL lines in
//  REVERSE for the LAST assistant / persisted api_error line and reading its
//  PARSED top-level error fields (scanTailForEndedOnError, pure in
//  sessionStoragePortable.ts — driven LIVE here). Spoof-safety is the trust
//  claim: a message that merely QUOTES an error-shaped literal must not mark a
//  session, and a truncated/metadata-only tail must return undefined (honest
//  absence), never a clean/error claim. formatLogMetadata then appends
//  '✕ ended on error' as the LAST metadata part — only when true.
//
//  sessionStorage.ts is heavy to load (bun:bundle), so its gate + plumbing are
//  locked by source-text; the scanner and the formatter run live.
//
//  Run: ~/.bun/bin/bun run scripts/tools/prove-ended-on-error-tail.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { scanTailForEndedOnError } from '../../src/utils/sessionStoragePortable.js'
import { formatLogMetadata } from '../../src/utils/format.js'
import { entryToRecord } from '../../src/fabric/entryCodec.js'
import { ordinalOf } from '../../src/fabric/ordinal.js'

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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' resume-picker end-state — ended-on-error tail scan')
console.log('============================================================')

// --- synthetic SerializedMessage JSONL lines (the real write shape: one
// JSON.stringify'd object per line, session-stamp fields at top level) --------
let seq = 0
const uid = () => `u-${seq++}`
const stamp = {
  parentUuid: null as string | null,
  isSidechain: false,
  userType: 'external',
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
// The fork's own persisted resume-recap card — carries "endedOnError":true in
// recapMetadata but is a SYSTEM away_summary line, which must never be ruled on.
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
  // Nested-JSON spoof: a tool_result whose payload embeds a REAL (unescaped)
  // {"type":"assistant","isApiErrorMessage":true} object — passes the substring
  // pre-filter, but parses to top-level type 'user' and is skipped.
  const nestedSpoof = userLine([
    { type: 'tool_result', tool_use_id: 'x', content: 'ok' },
    { type: 'text', text: 'payload follows' },
  ]).replace('"payload follows"', '"p","spoof":{"type":"assistant","isApiErrorMessage":true}')
  check('nested unescaped spoof line really contains the literal', nestedSpoof.includes('"type":"assistant"'))
  check('nested-JSON spoof after a clean assistant ⇒ false (not spoofed)', scanTailForEndedOnError(T(asstLine(), nestedSpoof)) === false)
  // String-quoted spoof: JSON.stringify escapes the quotes, so the literal
  // never even matches the pre-filter — belt and suspenders.
  const quotedSpoof = userLine([{ type: 'text', text: 'saw {"type":"assistant","isApiErrorMessage":true} in a log' }])
  check('string-quoted spoof serializes ESCAPED (pre-filter immune)', !quotedSpoof.includes('"type":"assistant"'))
  check('string-quoted spoof after a clean assistant ⇒ false', scanTailForEndedOnError(T(asstLine(), quotedSpoof)) === false)
  // Reverse spoof: a clean-LOOKING nested literal must not mask a real error end.
  const cleanLookingSpoof = userLine([{ type: 'tool_result', tool_use_id: 'y', content: 'ok' }]).replace('"ok"', '"o","spoof":{"type":"assistant","content":"all done"}')
  check('clean-looking nested spoof after an ERRORED assistant ⇒ still true', scanTailForEndedOnError(T(asstLine({ apiErr: true }), cleanLookingSpoof)) === true)
  // Our own persisted recap card carries "endedOnError":true — never ruled on.
  check('a persisted away_summary recap card (endedOnError:true) ⇒ ignored', scanTailForEndedOnError(T(asstLine(), awaySummaryLine())) === false)
}

section('(c) honest absence — truncated / unparseable / empty tails ⇒ undefined')
{
  check('empty tail ⇒ undefined', scanTailForEndedOnError('') === undefined)
  check('metadata-only tail ⇒ undefined', scanTailForEndedOnError(T(...metaLines)) === undefined)
  // Window boundary: the tail starts mid-way INSIDE the only assistant line —
  // the fragment still contains the literal but fails to parse ⇒ undefined.
  const cut = asstLine({ error: 'server_error' }).slice(40)
  check('boundary-truncated lone assistant line ⇒ undefined', cut.includes('"kind":"output"') && scanTailForEndedOnError(T(cut, ...metaLines)) === undefined)
  // Mid-append: the writer died mid-line — the truncated ERROR line is skipped
  // and the previous COMPLETE clean assistant line rules.
  const midAppend = T(asstLine()).slice(0, -1) + '\n' + asstLine({ apiErr: true }).slice(0, 60)
  check('mid-append truncated error line ⇒ prior complete clean line rules (false)', scanTailForEndedOnError(midAppend) === false)
  check('user-only tail (no assistant in window) ⇒ undefined', scanTailForEndedOnError(T(userLine([{ type: 'text', text: 'hello' }]))) === undefined)
}

section('(d) formatLogMetadata — the ✕ marker is the LAST part, only when true')
{
  const base = { modified: new Date(Date.now() - 3600_000), messageCount: 12, gitBranch: 'main', tag: 'work', prNumber: 7, prRepository: 'o/r' }
  const marked = formatLogMetadata({ ...base, endedOnError: true })
  const unmarkedFalse = formatLogMetadata({ ...base, endedOnError: false })
  const unmarkedAbsent = formatLogMetadata(base)
  console.log(`       → "${marked}"`)
  check('endedOnError: true ⇒ ends with the ✕ marker', marked.endsWith(' · ✕ ended on error'))
  check('marker is the LAST part (after tag + PR)', marked.indexOf('#work') !== -1 && marked.indexOf('✕ ended on error') > marked.indexOf('#work') && marked.indexOf('o/r#7') !== -1 && marked.indexOf('✕ ended on error') > marked.indexOf('o/r#7'))
  check('endedOnError: false ⇒ no marker', !unmarkedFalse.includes('ended on error'))
  check('endedOnError absent ⇒ byte-identical to false', unmarkedAbsent === unmarkedFalse)
}

section('(e) wiring — derivation gated on the fork, plumbed lite → LogOption → picker')
{
  // R5 module-scoped read: the log surface moved to the owned
// sessionStorage/ submodules; these invariants are module-scoped.
const _ssDir = join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage')
const storage = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'sessionStorage.ts'), 'utf-8') + readdirSync(_ssDir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(_ssDir, f), 'utf-8')).join('\n')
  check('readLiteMetadata derives via scanTailForEndedOnError (unconditional)', /const endedOnError = scanTailForEndedOnError\(tail\)/.test(storage))
  check('enrichLog copies it onto the LogOption', /endedOnError: meta\.endedOnError,/.test(storage))
  const logs = readFileSync(join(import.meta.dir, '..', '..', 'src', 'types', 'logs.ts'), 'utf-8')
  check('LogOption carries the optional field', /endedOnError\?: boolean/.test(logs))
  const selector = readFileSync(join(import.meta.dir, '..', '..', 'src', 'components', 'LogSelector.tsx'), 'utf-8')
  check('LogSelector renders it through the plain formatLogMetadata string (no bespoke path)', /formatLogMetadata\(log\)/.test(selector) && !selector.includes('endedOnError'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL ENDED-ON-ERROR TAIL PROOFS PASS')
else console.log(`❌ ${failures} ENDED-ON-ERROR PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
