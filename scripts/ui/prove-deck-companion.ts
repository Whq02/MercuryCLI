#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-deck-companion.ts — the deck companion row (the
//  buddy→critter merge).
//
//  Locks the LOGIC of the living companion row without racing a PTY:
//    1. gate polarity — the companion is DEFAULT-ON (declutter:
//       unset env + untouched toggle ⇒ on; '0' or /companion off disables)
//       and DeckPane mount-guards on it (source),
//    2. the signal seam — publishCompanionTurn edge-stamps turn start/end,
//       dedupes identical publishes, and notifies subscribers,
//    3. mood integration — the published signals drive buddyStateFor to the
//       moods the row renders (working/thinking/blocked/focused/done/idle),
//    4. speech — the voice law (scripts/critters/prove-companion-voice.ts
//       owns it); here: the row paints the creature and its name, with no
//       rarity layer (stars · shiny · personality) anywhere on a surface,
//    5. residue ratchet — the dead upstream buddy (src/buddy, /buddy command,
//       companion config/AppState fields) stays deleted, and the retired
//       soul/quip modules stay deleted,
//    6. capture hermeticity — renderScenarios pins MERCURY_DECK_COMPANION=0.
//
//  Under bun-run the build stamp is false (no build-time MACRO); the fork
//  is simulated per-case via globalThis.MACRO (config.ts reads it at call
//  time) — the wire-live substrate idiom.
// ============================================================================

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isDeckCompanionEnabled,
  setCompanionEnabled,
} from '../../src/components/mercury-ui/useCompanion.js'
import {
  companionTurnSignals,
  getCompanionSignalsVersion,
  publishCompanionTurn,
  resetCompanionSignals,
  subscribeCompanionSignals,
} from '../../src/utils/cockpit/companionSignals.js'
import { buddyStateFor, buddyTone } from '../../src/utils/cockpit/buddyState.js'
import { toCritterState } from '../../src/utils/cockpit/critterVariant.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf-8')

const MACRO_KEY = 'MACRO' as const
function simFork(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

console.log('============================================================')
console.log(' deck companion — buddy→critter merge proof')
console.log('============================================================')

// ── 1. the gate: env pin wins · /companion toggle persists (round-3) ─────────
section('1. companion gate — env pin > persisted /companion toggle > ON')
{
  const prevEnv = process.env.MERCURY_DECK_COMPANION
  const prevHome = process.env.MERCURY_CONFIG_DIR
  const home = mkdtempSync(join(tmpdir(), 'companion-proof-'))
  process.env.MERCURY_CONFIG_DIR = home
  simFork(true)
  try {
    delete process.env.MERCURY_DECK_COMPANION
    check('unset env + untouched toggle ⇒ ON (default-on since the declutter)', isDeckCompanionEnabled() === true)
    check('setCompanionEnabled(false) turns it OFF (the /companion toggle)', (setCompanionEnabled(false), isDeckCompanionEnabled() === false))
    check('the toggle PERSISTS (re-read from config)', isDeckCompanionEnabled() === false)
    process.env.MERCURY_DECK_COMPANION = '1'
    check("explicit env '1' wins over toggle-off", isDeckCompanionEnabled() === true)
    process.env.MERCURY_DECK_COMPANION = '0'
    setCompanionEnabled(true)
    check("explicit env '0' wins over toggle-on", isDeckCompanionEnabled() === false)
    delete process.env.MERCURY_DECK_COMPANION
    check('env unset again ⇒ the toggle (on) decides', isDeckCompanionEnabled() === true)
  } finally {
    if (prevEnv === undefined) delete process.env.MERCURY_DECK_COMPANION
    else process.env.MERCURY_DECK_COMPANION = prevEnv
    if (prevHome === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  }

  const deckPane = src('src', 'components', 'DeckPane.tsx')
  check(
    'DeckPane mount-guards the full row (standard tier)',
    /!compact && companionOn \? <DeckCompanion \/>/.test(deckPane),
  )
  check('the COMPACT DOCK docks the mini creature in the strip', /<MiniCritter cols=\{cols\} bare \/>/.test(deckPane))
  check('the dock carries the voice line', /<CompanionSpeechLine \/>/.test(deckPane))
  check('the ops row renders ONCE (standalone skipped while docked)', /\{compact && companionOn \? null : opsRow\}/.test(deckPane))
  // The consent surfaces: /companion registered + the boot-menu row.
  const cmds = src('src', 'commands.ts')
  check('/companion command is registered', /import companion from '\.\/commands\/companion\/index\.js'/.test(cmds) && /\n  companion,\n/.test(cmds))
  const menu = src('src', 'substrate', 'startupMenu.ts')
  check(
    'the boot menu row is RETIRED (the declutter) — tombstoned, not offered',
    !/Session companion/.test(menu) && /RETIRED_MENU_ENV/.test(menu),
  )
  // The talking surfaces: the transcript-top mini yields to the deck dock
  // (one creature on screen); the hero carries the bubble — and the BUBBLE
  // yields to the dock too (one VOICE: the dock's CompanionSpeechLine already
  // speaks the quip; a hero bubble beside it doubled the line at <100 cols —
  // premium-pass render).
  const home2 = src('src', 'components', 'MercuryHome.tsx')
  check('sub-hero mini yields when the deck pane owns the creature', /companionOn && !isDeckPaneActive\(\) && rows >= 10[\s\S]{0,200}<MiniCritter/.test(home2))
  check('hero mounts the speech bubble behind the gate', /companionOn[\s\S]{0,800}<HeroCompanionBubble \/>/.test(home2))
  check(
    'hero bubble yields to the dock voice (one voice on screen)',
    /companionOn && columns >= HERO_ART_COLS \+ 44 && !isDeckPaneActive\(\)/.test(home2),
  )
}

// ── 2. the signal seam ───────────────────────────────────────────────────────
section('2. companionSignals — edges, dedupe, notify')
{
  resetCompanionSignals()
  const v0 = getCompanionSignalsVersion()
  let pings = 0
  const off = subscribeCompanionSignals(() => {
    pings++
  })

  publishCompanionTurn({ turnLive: true, streaming: false, awaitingPermission: false })
  const live = companionTurnSignals()
  check('turn start stamps turnStartTs', live.turnLive && live.turnStartTs !== null)
  check('turn start bumps version + notifies', getCompanionSignalsVersion() === v0 + 1 && pings === 1)

  publishCompanionTurn({ turnLive: true, streaming: false, awaitingPermission: false })
  check(
    'identical publish is a no-op (dedupe)',
    getCompanionSignalsVersion() === v0 + 1 && pings === 1,
  )

  const startTs = live.turnStartTs
  publishCompanionTurn({ turnLive: true, streaming: true, awaitingPermission: false })
  check('streaming flip keeps the SAME turnStartTs', companionTurnSignals().turnStartTs === startTs)

  publishCompanionTurn({ turnLive: false, streaming: false, awaitingPermission: false })
  const ended = companionTurnSignals()
  check('turn end stamps lastTurnEndTs + clears turnStartTs', ended.lastTurnEndTs !== null && ended.turnStartTs === null)
  off()
  const pinged = pings
  publishCompanionTurn({ turnLive: true, streaming: false, awaitingPermission: false })
  check('unsubscribe stops notifications', pings === pinged)
  resetCompanionSignals()
}

// ── 3. mood integration (signals → buddyStateFor → pose/tone) ────────────────
section('3. published signals drive the ratified 8-mood deriver')
{
  const now = 1_800_000_000_000
  const row = { isMain: true, status: 'running' as const }
  const sig = (over: Record<string, unknown>) => ({
    activeStatus: null,
    activeStreaming: null,
    perm: null,
    justSettled: false,
    recentFail: false,
    // RE-CUT (operator sleep-word ruling): the main 'sleeping'
    // word rides the ONE critterSleep verdict (signals.asleep), never the
    // old 5-minute idleMs timer — the timer input died with the plumbing.
    asleep: false,
    ...over,
  })

  check(
    'live turn ⇒ working',
    buddyStateFor(row, sig({ activeStatus: { live: true, turnStartTs: new Date(now - 1000).toISOString() } }), now) === 'working',
  )
  check(
    'live turn past the focus threshold ⇒ focused',
    buddyStateFor(row, sig({ activeStatus: { live: true, turnStartTs: new Date(now - 6 * 60_000).toISOString() } }), now) === 'focused',
  )
  check(
    'streaming ⇒ thinking',
    buddyStateFor(row, sig({ activeStreaming: { text: 't' } }), now) === 'thinking',
  )
  check(
    'pending permission ⇒ blocked (trumps activity)',
    buddyStateFor(row, sig({ perm: {}, activeStatus: { live: true, turnStartTs: null } }), now) === 'blocked',
  )
  check('settle window ⇒ done', buddyStateFor(row, sig({ justSettled: true }), now) === 'done')
  check('recent fail ⇒ sad', buddyStateFor(row, sig({ recentFail: true }), now) === 'sad')
  check('nothing true ⇒ idle (activity never invented)', buddyStateFor(row, sig({}), now) === 'idle')
  check(
    'the critterSleep verdict ⇒ sleeping (one sleep truth, never a private timer)',
    buddyStateFor(row, sig({ asleep: true }), now) === 'sleeping',
  )

  check(
    'mood→pose seam is total (8 moods land on the 6-pose union)',
    (['idle', 'thinking', 'working', 'focused', 'blocked', 'sad', 'done', 'sleeping'] as const).every(m =>
      ['thinking', 'working', 'blocked', 'done', 'sleeping', 'idle'].includes(toCritterState(m)),
    ),
  )
  check(
    'tone keys stay on the token spine (blocked=CRIMSON, sad=AMBER, active=TEAL)',
    buddyTone('blocked') === 'CRIMSON' && buddyTone('sad') === 'AMBER' && buddyTone('working') === 'TEAL',
  )
}

// ── 4. the row is the creature and its name — no rarity layer anywhere ──────
section('4. the companion surfaces carry no rarity layer')
{
  const surfaces = [
    ['src', 'components', 'mercury-ui', 'DeckCompanion.tsx'],
    ['src', 'components', 'mercury-ui', 'MiniCritter.tsx'],
    ['src', 'components', 'mercury-ui', 'useCompanion.ts'],
    ['src', 'components', 'CritterSelect.tsx'],
    ['src', 'utils', 'cockpit', 'companionEngine.ts'],
    ['src', 'utils', 'cockpit', 'critterProfile.ts'],
  ]
  for (const p of surfaces) {
    const text = src(...p)
    check(
      `${p[p.length - 1]}: no stars · shiny · rarity · personality · soul`,
      !/\bstars\b|\bshiny\b|\brarity\b|personality|\bsoul\b/i.test(text),
    )
  }
  const deck = src('src', 'components', 'mercury-ui', 'DeckCompanion.tsx')
  check('the full row paints the creature name in its accent', /<Text color=\{c\.critter\.accent\}>\{c\.critter\.name\}<\/Text>/.test(deck))
  check('the row adds the separator ONLY beside a live line (silent ⇒ name is the row)', /line \? \(\s*<>\s*<Text color=\{FAINT\}> · <\/Text>/.test(deck))
  check('the compact chip is glyph + name', /DeckCompanionChip[\s\S]{0,600}<Text color=\{c\.critter\.accent\}>\{c\.critter\.name\}<\/Text>\s*<\/Text>/.test(deck))
}

// ── 5. residue ratchet — the upstream buddy stays deleted ────────────────────
section('5. dead-buddy residue ratchet')
{
  check('src/buddy/ is gone', !existsSync(join(ROOT, 'src', 'buddy')))
  check('the soul module is gone', !existsSync(join(ROOT, 'src', 'utils', 'critterSoul.ts')))
  check('the quip module is gone', !existsSync(join(ROOT, 'src', 'utils', 'cockpit', 'critterQuips.ts')))
  const cmds = src('src', 'commands.ts')
  check('no /buddy command residue in commands.ts', !/commands\/buddy\//.test(cmds))
  const config = src('src', 'utils', 'config.ts')
  check('config has no companion fields', !/companionMuted|StoredCompanion/.test(config))
  const appState = src('src', 'state', 'AppStateStore.ts')
  check(
    'AppState has no companionReaction/companionPetAt',
    !/companionReaction|companionPetAt/.test(appState),
  )
  const repl = src('src', 'screens', 'REPL.tsx')
  check('REPL publishes the companion signals instead', /publishCompanionTurn\(/.test(repl))
  const attachments = src('src', 'utils', 'attachments', 'types.ts')
  check('companion_intro attachment type is gone', !/companion_intro/.test(attachments))
}

// ── 6. capture hermeticity ───────────────────────────────────────────────────
section('6. renderScenarios pins the row off')
{
  const scen = src('scripts', 'ui', 'renderScenarios.ts')
  check(
    "renderScenarios pins MERCURY_DECK_COMPANION ?? '0'",
    /MERCURY_DECK_COMPANION\s*=\s*process\.env\.MERCURY_DECK_COMPANION\s*\?\?\s*'0'/.test(scen),
  )
}

// ── 7. the COCKPIT mount ─────────────────────────────────────
// The cockpit sheds MercuryHero for PinnedCritterBerth, which orphaned the
// armed companion on the operator's daily surface ("not observable on
// frontend" — render-proven). Three anchors keep the fix wired:
section('7. cockpit berth mounts the companion + idle presence')
{
  const mini = src('src', 'components', 'mercury-ui', 'MiniCritter.tsx')
  check('MiniCritter exports the self-gating BerthCompanionLine', /export function BerthCompanionLine/.test(mini))
  check(
    'HeroCompanionBubble is SILENT when idle (no name tag beside the critter — operator ruling; the mascot stands alone)',
    /if \(!line\) \{\s*return null\s*\}/.test(mini) && !/\{c\.critter\.name\}/.test(mini),
  )
  const layout = src('src', 'components', 'FullscreenLayout.tsx')
  check('FullscreenLayout mounts BerthCompanionLine in the berth card', /<BerthCompanionLine \/>/.test(layout))
}

console.log('\n============================================================')
if (failures) {
  console.log(`❌ DECK COMPANION RED — ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ ALL DECK COMPANION PROOFS PASS')
