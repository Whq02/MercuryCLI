#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-impl-nameplate.ts
//  PROOF (#36): a relayed teammate message renders in scribe mode as a nameplated
//  chat line — `HH:MM:SS [Mercury-Implement]` (the transcript nameplate idiom) —
//  instead of the plain `@implementer▶` (no time, off-brand id). The teammate
//  render path (UserTextMessage→UserTeammateMessage) carries NO TranscriptNameplate,
//  so we stamp the identity in a scribe-mode branch. Structural (the Ink component
//  doesn't load under bare bun) + a logic check of the name mapping where loadable.
//  Live render is constrained: the Implementer's normal envelopes render null (the
//  Scribe relays as [Mercury-Amanuensis]); this fires for non-envelope teammate prose.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-impl-nameplate.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Implementer nameplate in the REPL (#36) — proof')
console.log('============================================================')

section('scribeRelayName mapping (logic, if the module loads)')
try {
  const m = (await import('../../src/components/messages/UserTeammateMessage.js')) as { scribeRelayName?: (id: string) => string }
  if (typeof m.scribeRelayName === 'function') {
    check('implementer ⇒ Mercury-Implement', m.scribeRelayName('implementer') === 'Mercury-Implement')
    check('scribe / team-lead ⇒ Mercury-Amanuensis', m.scribeRelayName('scribe') === 'Mercury-Amanuensis' && m.scribeRelayName('team-lead') === 'Mercury-Amanuensis')
    check('unknown id ⇒ the id (no crash)', m.scribeRelayName('alice') === 'alice')
  } else {
    console.log('  [skip] scribeRelayName not exported as a function (module loaded)')
  }
} catch {
  console.log('  [skip] UI module not loadable under bare bun — covered structurally below')
}

section('wiring — the scribe branch renders the nameplate, not @implementer▶')
const utm = src('components', 'messages', 'UserTeammateMessage.tsx')
check('scribe-mode branch renders the relay nameplate (mode-gated, chatroom rides ChatLine)', /if \(isScribeModeOn\(\)\) \{/.test(utm) && /<ChatLine/.test(utm))
// bus-identity refactor: the mapping now derives from busIdentity
// (the ONE address+display source) instead of file-local literals — assert the
// derivation AND the leaf's actual values, so a rebrand that forks the two
// still fails here.
const busIdentitySrc = src('utils', 'scribe', 'busIdentity.ts')
check(
  'maps implementer ⇒ Mercury-Implement (via busIdentity)',
  /IMPLEMENTER_AGENT_NAME\) return IMPLEMENTER_DISPLAY_NAME/.test(utm) &&
    /IMPLEMENTER_AGENT_NAME = 'implementer'/.test(busIdentitySrc) &&
    /IMPLEMENTER_DISPLAY_NAME = 'Mercury-Implement'/.test(busIdentitySrc),
)
check(
  'maps scribe/team-lead ⇒ Mercury-Amanuensis (via busIdentity)',
  /return SCRIBE_DISPLAY_NAME/.test(utm) && /SCRIBE_DISPLAY_NAME = 'Mercury-Amanuensis'/.test(busIdentitySrc),
)
check('renders the bracketed [name] (not @id▶)', /\[<\/Text>[\s\S]{0,120}\{senderName\}[\s\S]{0,120}\] </.test(utm))
check('name carries the sender color, brackets/clock dim (nameplate palette)', /color=\{toInkColor\(message\.color\)\}>\{senderName\}/.test(utm) && /\{clock \? <Text dimColor>\{clock\} <\/Text>/.test(utm))
check('time is the message stored timestamp (useMessageMeta + formatClock(meta.timestamp))', /useMessageMeta\(\)/.test(utm) && /formatClock\(meta\?\.timestamp\)/.test(utm))
check('OFF/non-scribe ⇒ the plain @pointer row (no nameplate)', /\{figures\.pointer\} @\{senderName\}/.test(utm))

section('nameplate helpers exported from TranscriptNameplate')
const tn = src('components', 'messages', 'TranscriptNameplate.tsx')
check('exports useMessageMeta', /export function useMessageMeta\(\)/.test(tn))
check('exports formatClock', /export function formatClock\(/.test(tn))
check('formatClock self-omits a missing/unparseable stamp (no fabricated time)', /if \(!ts\) return null/.test(tn) && /Number\.isNaN[\s\S]{0,40}return null/.test(tn))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL IMPL-NAMEPLATE PROOFS PASS')
else console.log(`❌ ${failures} IMPL-NAMEPLATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
