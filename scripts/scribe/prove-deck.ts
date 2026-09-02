#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-deck.ts
//  W4 — UI re-architecture (REPL = the conversation, deck = the workspace).
//  Structural lock-in (the VISUAL render is the vshot verify at cols 80/120; this
//  guards the wiring against regressions):
//   (a) RETIRED: the split-pane / 3-way view / "awaiting bridge" / WoW chat tabs /
//       ctrl+x v+t / scribeViewState + scribeChatTab state are all gone, and the
//       scribeView.ts module is deleted.
//   (b) REPL: the transcript is the single scrollable (scrollable={transcriptBody});
//       displayedMessages no longer branches on a scribe view.
//   (c) DECK: a scribe-mode-gated workspace — dual-agent status (Scribe +
//       Implementer w/ model·effort·ctx% via ProgressBar), prompt ledger
//       (buildScribeLedger), reasoning feed (scribeReasoningFeed), Implementer telemetry
//       from the W5 daemonRosterSnapshot.
//
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-deck.ts
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(root, 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' W4 deck/REPL re-architecture — structural lock-in')
console.log('============================================================')

const repl = src('screens', 'REPL.tsx')
const deck = src('components', 'DeckPane.tsx')
const store = src('state', 'AppStateStore.ts')
const frame = src('components', 'MercuryFrame.tsx')
const binds = src('keybindings', 'defaultBindings.ts')
const schema = src('keybindings', 'schema.ts')

section('(a) the retired split-pane / 3-way view / chat tabs are GONE')
check('REPL: no scribeImplementerFull', !/scribeImplementerFull/.test(repl))
check('REPL: no scribeScrollable / scribeImplementerPane', !/scribeScrollable|scribeImplementerPane/.test(repl))
check('REPL: no implementerMirroredMessages', !/implementerMirroredMessages/.test(repl))
check('REPL: no scribeViewState read', !/scribeViewState/.test(repl))
check('no "awaiting bridge" fake specimen anywhere in REPL/deck', !/awaiting bridge/.test(repl) && !/awaiting bridge/.test(deck))
check('AppState: scribeViewState removed', !/scribeViewState\?:/.test(store))
check('AppState: scribeChatTab removed', !/scribeChatTab\?:/.test(store))
check('AppState: scribeTranscript KEPT (deck ledger/feed source)', /scribeTranscript\?:\s*Message\[\]/.test(store))
check('MercuryFrame: no scribeViewState reader (keeps the ●/○ scribe chip)', !/scribeViewState/.test(frame) && /isScribeModeOn\(\)/.test(frame))
check('keybindings: chat:cycleViewMode + chat:cycleChatTab removed', !/cycleViewMode/.test(schema) && !/cycleViewMode/.test(binds) && !/cycleChatTab/.test(binds))
check('scribeView.ts module deleted', !existsSync(join(root, 'src', 'utils', 'scribe', 'scribeView.ts')))
check('ScribeChatTabs.tsx component deleted', !existsSync(join(root, 'src', 'components', 'ScribeChatTabs.tsx')))

section('(b) REPL = the single conversation transcript')
check('scrollable is the bare transcript body', /scrollable=\{transcriptBody\}/.test(repl))
// Pin over the REPL: the message source is the two-way selection (virtual
// transcript → the live/deferred transcript) — same no-scribe-branch law.
// Law 9 dissolved the agent-view arm: every chat renders through the focused
// connector, so a seat's transcript IS the focused transcript.
check('displayedMessages no longer branches on a scribe view', /const displayedMessages = inVirtualTranscript \? transcriptMessages : liveOrDeferred/.test(repl) && !/scribeImplementerFull\s*\n?\s*\?/.test(repl))

section('(c) deck = the Scribe workspace (dual-agent status + ledger + feed)')
check('gated on scribe mode', /isScribeModeOn\(\)\s*\n?\s*\?\s*\(\(\) =>/.test(deck))
check('dual-agent status: a Scribe row + an Implementer row', /Scribe<\/Text>/.test(deck) && /Implementer<\/Text>/.test(deck))
check('Scribe ctx% from getLiveContextUsage()', /getLiveContextUsage\(\)\.usedPct/.test(deck))
// Phase 3c: the roster snapshot rides the shared telemetry bus now.
const bus = src('state', 'telemetryBus.ts')
check('Implementer telemetry from the W5 roster snapshot (via the telemetry bus)', /implRoster\?\.entry/.test(deck) && /daemonRosterSnapshot\(\)/.test(bus))
check('ctx% rendered via ProgressBar', /<ProgressBar value=\{scribeCtx\}/.test(deck) && /<ProgressBar value=\{impl\.contextPct\}/.test(deck))
check('respawns surfaced when present', /impl\.respawns/.test(deck))
check('Implementer true-idle: distinguishes busy/idle (#25)', /impl\.busy === true[\s\S]{0,120}working[\s\S]{0,120}impl\.busy === false[\s\S]{0,90}idle/.test(deck))
check('prompt ledger via buildScribeLedger', /buildScribeLedger\(chatMessages\)/.test(deck))
check('reasoning feed via scribeReasoningFeed (prose only — not rowsForTab)', /scribeReasoningFeed\(chatMessages/.test(deck) && !/rowsForTab\(chatMessages/.test(deck))
check('feed flashes TEAL on a new turn (feedFlash + 1.4s timeout)', /feedFlash/.test(deck) && /setFeedFlash\(true\)/.test(deck) && /setFeedFlash\(false\)/.test(deck))
check('Implementer poll is scribe-mode-gated (no RPC traffic otherwise)', /isScribeModeOn\(\)\s*\?\s*daemonRosterSnapshot\(\)/.test(bus))

section('(d) declutter follow-up — footer slimmed, deck gained the profile flags + router 1M')
// Footer: no visual ctx gauge (publishContextUsage KEPT for the deck). The per-session fable
// indicator is the fableBAND — its SINGLE owner (no in-frame fable
// chip); behaviorNode is SCRIBE-only. Set-and-forget profile flags (wrapper/substrate) → deck.
check('footer dropped the visual ctx gauge', !/let gauge/.test(frame))
check('footer KEEPS publishContextUsage (deck ctx bar + Scribe ctx% depend on it)', /publishContextUsage/.test(frame))
check('footer: behaviorNode stays scribe-only', /behaviorNode = scribeOn/.test(frame) && /isScribeModeOn\(\)/.test(frame))
check('footer no longer CALLS doctrine/substrate (moved to the deck)', !/mercuryDoctrineEnabled\(\)/.test(frame) && !/isMercurySubstrateProfileOn\(\)/.test(frame))
// declutter: the profile flags moved AGAIN — off the pinned strip
// (DeckPane) to the full /deck snapshot (Deck.tsx governance chip row), the
// single owner of set-and-forget posture. The strip keeps live vitals only.
const fullDeck = src('components', 'Deck.tsx')
check('full /deck owns the doctrine profile chip', /mercuryDoctrineEnabled\(\)/.test(fullDeck) && /doctrine/.test(fullDeck))
check('full /deck owns the substrate chip', /substrateOn/.test(fullDeck))
check('the deck STRIP no longer renders the profile flags (live vitals only)', !/mercuryDoctrineEnabled\(\)/.test(deck) && !/isMercurySubstrateProfileOn\(\)/.test(deck))
const opts = src('utils', 'model', 'modelOptions.ts')
const pinSrc = src('utils', 'scribe', 'scribeModelPin.ts')
const pickerSrc = src('components', 'ModelPicker.tsx')
const esd = src('utils', 'scribe', 'ensureScribeDaemon.ts')
// SEAT-DERIVED since (the minted gpt[1m] class): the sentinel's
// 1M affordance follows the RESOLVED scribe seat, never an unconditional true.
check('focusedOptionSupports1m derives the router sentinel from the scribe seat', /SCRIBE_ROUTER_OPTION_VALUE\) \{\s*\n\s*return focusedOptionSupports1m\(stripContext1m\(resolveScribeSeat\(\)\.model\)\)/.test(opts))
check('the scribe pin resolves a 1M-context preference', /export function resolvedScribeModel/.test(pinSrc) && /scribeContext1mPref/.test(pinSrc))
check('ModelPicker rides the c toggle onto the router sentinel', /SCRIBE_ROUTER_OPTION_VALUE\)\s*\{[\s\S]{0,160}withContext1m\(value_0\)/.test(pickerSrc))
check('ensureScribeDaemon reaps the auto-started daemon via the owned-daemon seam', /spawnOwnedDaemon\(projectDir/.test(esd) && /reapDaemonOnSessionExit\(child\.pid\)/.test(src('daemon', 'ownedDaemon.ts')))

section('(e) A1 multiplayer — the self-omitting "watch your friend" seats row')
check('subscribes to live presence via useSyncExternalStore(subscribePresence)', /useSyncExternalStore\(subscribePresence/.test(deck))
check('reads the live peer set (getLivePresence) — already self-excluded by the tailer', /getLivePresence\(\)/.test(deck))
check('the whole seats block is omitted when no peers are live (solo → byte-identical)', /seats\.length > 0 \?/.test(deck))
check('each seat renders seat·verb·⌥branch·last-line (success-token seat + ⌥branch glyph)', /color=\{tok\.success\}>\{s\.seat\}/.test(deck) && /· ⌥/.test(deck) && /truncateToWidth\(s\.branch/.test(deck))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DECK PROOFS PASS')
else console.log(`❌ ${failures} DECK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
