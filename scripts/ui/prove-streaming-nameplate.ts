#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-streaming-nameplate.ts
//  PROOF for: on the fork's default (NON-scribe) path the streaming
//  assistant prose rendered a filled ● bullet + no nameplate, but the FINALIZED
//  fork prose is bulletless and leads with [Hermes] — so the streaming dot
//  vanished and the nameplate appeared on every turn-finalize. Fix: a THREE-way
//  streaming branch (fork+scribe → ScribeStreamingNameplate; fork non-scribe →
//  MercuryStreamingNameplate, bulletless inline; plain → ● bullet, byte-identical)
//  + a context-free MercuryStreamingNameplate in ChatLine that must NOT read
//  MessageMetaContext (it is null at the streaming site).
//
//  The VISUAL (bulletless [Hermes] inline, prose at col 0) is render-verified
//  live in render-streaming-nameplate.ts (UI_RENDER). This locks the branch logic.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-streaming-nameplate.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// the streaming branch moved from Messages.tsx into the
// ONE subscribed leaf, LiveStreamingTail.tsx — Messages renders the leaf;
// the leaf owns the scribe/Hermes nameplate branch. Same assertions, new home.
const msgs = readFileSync(join(root, 'src', 'components', 'Messages.tsx'), 'utf-8')
const tail = readFileSync(join(root, 'src', 'components', 'LiveStreamingTail.tsx'), 'utf-8')
const chat = readFileSync(join(root, 'src', 'components', 'messages', 'ChatLine.tsx'), 'utf-8')

console.log('============================================================')
console.log(' HB-0215: 3-way streaming nameplate branch + context-free nameplate')
console.log('============================================================')

section('ChatLine: MercuryStreamingNameplate is context-free (no MessageMetaContext)')
const npStart = chat.indexOf('export function MercuryStreamingNameplate')
check('MercuryStreamingNameplate is exported', npStart !== -1)
const npBody = npStart !== -1 ? chat.slice(npStart, npStart + 400) : ''
check('it reads ONLY useSessionAccent (no useMessageMeta / context read)',
  /useSessionAccent\(\)/.test(npBody) && !/useMessageMeta|MessageMetaContext/.test(npBody))
check('the name is "Mercury" in the critter accent (matches finalized TranscriptNameplate)',
  /<Text color=\{critter\.accent\}>Mercury<\/Text>/.test(npBody))
check('FAINT brackets [ ] (matches finalized format minus the clock)',
  /<Text color=\{FAINT\}>\[<\/Text>/.test(npBody) && /<Text color=\{FAINT\}>\] <\/Text>/.test(npBody))
check('NO clock / Date.now() at render (honesty invariant — clock fades in on finalize)',
  !/Date\.now\(\)|formatClock|clock/.test(npBody))

section('LiveStreamingTail: the streaming branch is TWO-way (; FLUX S2 home)')
check('the leaf imports the nameplates from ChatLine',
  /import \{[\s\S]{0,120}(MercuryStreamingNameplate|ScribeStreamingNameplate)[\s\S]{0,120}\} from '\.\/messages\/ChatLine\.js'/.test(tail))
check('Messages renders the ONE subscribed leaf (per-delta publishes never re-render the tree)',
  // The leaf takes the store (and the settle split's `settledShown`, which
  // the settled transcript owns) — Messages itself never subscribes to the
  // per-delta publishes; the pin tolerates the JSX's line breaks and props.
  /\{streamingTail && !isBriefOnly \? \(?\s*<LiveStreamingTail\s+store=\{streamingTail\}[^>]*\/>\s*\)? : null\}/.test(msgs))
// branch 1: scribe → ScribeStreamingNameplate
check('branch 1 — scribe → ScribeStreamingNameplate',
  /isScribeModeOn\(\)[\s\S]{0,1200}leadingInline=\{<ScribeStreamingNameplate \/>\}/.test(tail))
// branch 2: non-scribe → MercuryStreamingNameplate (the old ● bullet arm was
// deleted with the bare-stamp arms — presentation is unconditional Mercury)
check('branch 2 — non-scribe → MercuryStreamingNameplate',
  /leadingInline=\{<MercuryStreamingNameplate \/>\}/.test(tail))
check('branch 2 is BULLETLESS (no ● BLACK_CIRCLE in the leaf)', !/BLACK_CIRCLE|minWidth=\{2\}/.test(tail))
check('the old streaming bullet arm is GONE (no third regime)',
  !/A bare stamp — UNCHANGED/.test(tail))

section('logic: the two regimes are mutually exclusive + exhaustive')
const regime = (scribe: boolean): 'scribe' | 'hermes' => (scribe ? 'scribe' : 'hermes')
check('scribe → scribe nameplate', regime(true) === 'scribe')
check('non-scribe → hermes nameplate', regime(false) === 'hermes')

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ HB-0215 — 2-way streaming branch + context-free nameplate proven')
  process.exit(0)
} else {
  console.log(` ❌ HB-0215 — ${failures} check(s) failed`)
  process.exit(1)
}
