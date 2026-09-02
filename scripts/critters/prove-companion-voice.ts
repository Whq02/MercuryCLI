#!/usr/bin/env bun
// ============================================================================
//  scripts/critters/prove-companion-voice.ts — the companion's voice: the
//  approved words, the pure voice law, and the engine's use of both.
//
//  §1 THE WORDS (companionWords) — the operator-approved bank, verbatim:
//     every line ≤ 40 cells, plain words (no exclamation marks, no emoji),
//     every `/command` it names is a registered slash command, the two
//     replacement lines the operator ruled are present, every tip id is
//     unique, and every area of the ruling has tips.
//  §2 THE LAW (companionVoice) on a pinned clock — consecutive settles never
//     both speak; any two lines sit the cooldown apart; holding/failure may
//     interrupt the cooldown but not each other within the gap; the seeded
//     deck is deterministic, never repeats a line back-to-back, and never
//     hands out a fixed rotation; tips honour the seen memory, the boot
//     quiet, the tip cooldown, and the situational signals (context meter,
//     never-opened surface); an explicit ask relaxes the seen filter.
//  §3 THE ENGINE (companionEngine) — a session-start tip after the boot
//     quiet marks the tip seen in the profile; a return after ten minutes of
//     quiet speaks a silence line; `/companion tip` returns a bank tip.
// ============================================================================
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'companion-voice-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DECK_COMPANION = '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n── ${t} ──`)
}

const words = await import('../../src/utils/cockpit/companionWords.ts')
const voice = await import('../../src/utils/cockpit/companionVoice.ts')

// ── §1 the words ────────────────────────────────────────────────────────────
section('§1 the approved words')
{
  const all = words.everyCompanionLine()
  const wide = all.filter(l => Bun.stringWidth(l) > words.MAX_LINE_CELLS)
  check(`every line is ≤ ${words.MAX_LINE_CELLS} cells (${all.length} lines)`, wide.length === 0, wide.join(' | '))
  // The cap holds under EVERY host spelling, not just this box's: the bank
  // bakes the live host's chord fold at import, so a mac-authored '⌥' line
  // can hide a linux 'alt+' width. Cross-folding each baked line through
  // every platform reproduces the widest spelling on any host (off-mac
  // banks carry no glyphs, so the extra folds are identity there).
  const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
  const everyPlatform = ['macos', 'windows', 'wsl', 'linux', 'unknown'] as const
  const wideAnywhere = all.flatMap(l =>
    everyPlatform.map(p => ({ l, p, w: Bun.stringWidth(keyHintLabel(l, p)) })).filter(x => x.w > words.MAX_LINE_CELLS),
  )
  check(
    `every line fits the cap in EVERY host spelling (${all.length} lines × ${everyPlatform.length} platforms)`,
    wideAnywhere.length === 0,
    wideAnywhere.map(x => `${x.p}:${x.w}:${x.l}`).join(' | '),
  )
  check('no exclamation marks', all.every(l => !l.includes('!')))
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u
  check('no emoji', all.every(l => !emojiRe.test(l)))
  check('the bank holds 57 tips', words.TIP_BANK.length === 57, String(words.TIP_BANK.length))
  check(
    'each moment has 8 lines',
    (['settled-long', 'holding', 'failure', 'silence'] as const).every(m => words.MOMENT_LINES[m].length === 8),
  )
  const ids = new Set(words.TIP_BANK.map(t => t.id))
  check('every tip id is unique', ids.size === words.TIP_BANK.length)
  const areas = new Set(words.TIP_BANK.map(t => t.area))
  check(
    'every area of the ruling has tips (minerva · context · models · mcp · sessions · keys · agents · worktrees)',
    ['minerva', 'context', 'models', 'mcp', 'sessions', 'keys', 'agents', 'worktrees'].every(a => areas.has(a as never)),
  )
  check(
    "the operator's two replacement lines are present verbatim",
    all.includes('Done in a worktree? Keep it or drop it.') && all.includes('/branch asks a side question, no derail.'),
  )
  check('the lines they replaced are gone', !all.includes('Leaving a worktree keeps or drops it.') && !all.includes('/branch forks a bounded side question.'))

  // Every /command the bank names is a registered slash command (a `name:`
  // in a command definition under src/commands).
  const registered = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\bname:\s*'([a-z][a-z0-9-]*)'/g)) registered.add(m[1]!)
      }
    }
  }
  walk(join(ROOT, 'src', 'commands'))
  const named = new Set<string>()
  for (const l of all) for (const m of l.matchAll(/\/([a-z][a-z0-9-]*)/g)) named.add(m[1]!)
  const unknown = [...named].filter(n => !registered.has(n))
  check(`every /command the bank names is registered (${named.size} named)`, unknown.length === 0, unknown.join(', '))
  const surfaces = words.TIP_BANK.map(t => t.surface).filter((s): s is string => s !== undefined)
  const unknownSurfaces = surfaces.filter(s => !registered.has(s))
  check('every tip surface is a registered command', unknownSurfaces.length === 0, unknownSurfaces.join(', '))
}

// ── §2 the law on a pinned clock ────────────────────────────────────────────
section('§2 the voice law')
{
  const T0 = 1_800_000_000_000
  const s = voice.freshVoiceState()
  check('a fresh voice may speak a long settle', voice.maySpeak(s, 'settled-long', T0))
  voice.noteSpoken(s, 'settled-long', 'a', T0)
  voice.noteSettle(s, true)
  check('a settle right after a spoken settle is silent (consecutive rule)', !voice.maySpeak(s, 'settled-long', T0 + voice.VOICE_COOLDOWN_MS + 1))
  voice.noteSettle(s, false)
  check('after a silent settle the next long settle may speak once the cooldown passed', voice.maySpeak(s, 'settled-long', T0 + voice.VOICE_COOLDOWN_MS + 1))
  check('inside the cooldown a silence line waits', !voice.maySpeak(s, 'silence', T0 + 30_000))
  check('inside the cooldown a hold may interrupt', voice.maySpeak(s, 'holding', T0 + 30_000))
  voice.noteSpoken(s, 'holding', 'h', T0 + 30_000)
  check('a failure cannot stack on a hold within the interrupt gap', !voice.maySpeak(s, 'failure', T0 + 30_000 + 10_000))
  check('a failure may follow a hold after the interrupt gap', voice.maySpeak(s, 'failure', T0 + 30_000 + voice.INTERRUPT_GAP_MS + 1))

  // the deck
  const pool = ['one', 'two', 'three', 'four']
  const d1 = voice.createDeck('seed-A')
  const d2 = voice.createDeck('seed-A')
  const seq1 = Array.from({ length: 12 }, () => d1.draw(pool, []))
  const seq2 = Array.from({ length: 12 }, () => d2.draw(pool, []))
  check('the same seed draws the same sequence', seq1.join(',') === seq2.join(','))
  check('every card of the pool is drawn in the first pass', new Set(seq1.slice(0, 4)).size === 4)
  check('no card repeats back-to-back across a reshuffle', seq1.every((c, i) => i === 0 || c !== seq1[i - 1]))
  const d3 = voice.createDeck('seed-B')
  const seq3 = Array.from({ length: 12 }, () => d3.draw(pool, []))
  check('a different seed draws a different order', seq1.join(',') !== seq3.join(','))
  check('an avoided card is never drawn', Array.from({ length: 20 }, () => d3.draw(pool, ['one'])).every(c => c !== 'one'))
  check('a pool whose every card is avoided draws nothing (honest silence)', d3.draw(['only'], ['only']) === null)
  const v = voice.freshVoiceState()
  const lineA = voice.chooseLine(voice.createDeck('x'), v, 'holding', words.MOMENT_LINES.holding)
  check('chooseLine draws from the moment pool', lineA !== null && words.MOMENT_LINES.holding.includes(lineA))

  // tips
  const boot = T0
  const tv = voice.freshVoiceState()
  check('no tip inside the boot quiet', !voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS - 1, boot))
  check('a tip after the boot quiet', voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS, boot))
  voice.noteTip(tv, 'tip', boot + voice.TIP_BOOT_QUIET_MS)
  check('no second tip inside the tip cooldown', !voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS + voice.TIP_COOLDOWN_MS - 1, boot))
  check('a tip again after the tip cooldown', voice.mayTip(tv, boot + voice.TIP_BOOT_QUIET_MS + voice.TIP_COOLDOWN_MS, boot))
  const tipDeck = voice.createDeck('tips')
  const none = new Set<string>()
  const ctxTip = voice.pickTip(tipDeck, voice.freshVoiceState(), words.TIP_BANK, {}, { contextPct: 75, openedSurfaces: none }, T0)
  check('a full context meter prefers a context tip', ctxTip?.area === 'context', ctxTip?.id)
  const opened = new Set(words.TIP_BANK.map(t => t.surface).filter((s): s is string => s !== undefined && s !== 'rewind'))
  const unopened = voice.pickTip(tipDeck, voice.freshVoiceState(), words.TIP_BANK, {}, { contextPct: 10, openedSurfaces: opened }, T0)
  check('the one never-opened surface ranks its tip first', unopened?.surface === 'rewind', unopened?.id)
  const seen: Record<string, number> = {}
  for (const t of words.TIP_BANK) seen[t.id] = T0 - 1_000
  check('every tip seen recently ⇒ nothing to say', voice.pickTip(tipDeck, voice.freshVoiceState(), words.TIP_BANK, seen, { contextPct: null, openedSurfaces: none }, T0) === null)
  check('an explicit ask relaxes the seen filter', voice.pickTip(tipDeck, voice.freshVoiceState(), words.TIP_BANK, seen, { contextPct: null, openedSurfaces: none }, T0, true) !== null)
  const aged = voice.pickTip(tipDeck, voice.freshVoiceState(), words.TIP_BANK, seen, { contextPct: null, openedSurfaces: none }, T0 + voice.TIP_SEEN_TTL_MS)
  check('a seen tip returns after its memory ages out', aged !== null)
}

// ── §3 the engine ───────────────────────────────────────────────────────────
section('§3 the engine speaks on quiet moments and remembers')
{
  const { publishCompanionTurnAt, resetCompanionSignals } = await import('../../src/utils/cockpit/companionSignals.ts')
  const engine = await import('../../src/utils/cockpit/companionEngine.ts')
  const profile = await import('../../src/utils/cockpit/critterProfile.ts')
  const { switchSession } = await import('../../src/bootstrap/state.ts')
  const tipTexts = new Set(words.TIP_BANK.map(t => t.text))
  let now = 1_800_000_000_000
  engine.setCompanionClockForProofs(() => now)
  switchSession('dddddddd-0000-4000-8000-000000000001' as never)
  engine.resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = engine.subscribeCompanionEngine(() => {})
  check('at boot the companion is silent', engine.companionEngineSnapshot().quip === null)
  now += voice.TIP_BOOT_QUIET_MS + 1_000
  engine.recomputeCompanionForProofs()
  const bootTip = engine.companionEngineSnapshot().quip
  check('after the boot quiet a session-start tip shows (from the bank)', bootTip?.kind === 'tip' && tipTexts.has(bootTip.text), bootTip?.text)
  const shownId = words.TIP_BANK.find(t => t.text === bootTip?.text)?.id
  check('the shown tip is marked seen in the profile', shownId !== undefined && profile.seenTipStamps()[shownId] === now)
  now += engine.TIP_MS + 2_000
  engine.recomputeCompanionForProofs()
  check('the tip expires', engine.companionEngineSnapshot().quip === null)

  // a return after a long quiet speaks a silence line
  now += voice.RETURN_AFTER_MS + 60_000
  publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
  engine.recomputeCompanionForProofs()
  const back = engine.companionEngineSnapshot().quip
  check('a turn after ten quiet minutes speaks a silence line', back?.kind === 'moment' && words.MOMENT_LINES.silence.includes(back.text), back?.text)
  publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now + 2_000)
  now += 2_000
  engine.recomputeCompanionForProofs()

  // /companion tip — on demand
  const onDemand = engine.requestCompanionTip()
  check('/companion tip returns a bank tip', onDemand !== null && tipTexts.has(onDemand), onDemand ?? 'null')
  check('the on-demand tip shows on the row', engine.companionEngineSnapshot().quip?.text === onDemand)
  unsub()
  engine.setCompanionClockForProofs(null)
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ COMPANION VOICE GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
