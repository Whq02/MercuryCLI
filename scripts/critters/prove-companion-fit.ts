#!/usr/bin/env bun
// ============================================================================
//  scripts/critters/prove-companion-fit.ts — no tip and no moment line may
//  ever overflow its row.
//
//  §1 THE BUDGETS — every bank line (tips + moment lines) fits every
//     companion surface's budget at 120x40 AND 100x30, with the widest
//     creature name on the row: the full deck row, the compact dock line,
//     the hero berth bubble, the mini critter bubble (companionBudget).
//  §2 THE ENGINE — a surface's budget gates the choice: with a narrow budget
//     registered, a long run settles SILENT and `/companion tip` answers
//     null (the negative case: an over-long line is skipped, never cut);
//     with a fitting budget the same moments speak; a live line that stops
//     fitting (the budget shrinks) leaves the screen.
//  §3 THE SURFACES — every speaking surface reports a budget and paints a
//     line only through the fit law; no companion line is truncated at
//     render (source pins).
// ============================================================================
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const home = mkdtempSync(join(tmpdir(), 'companion-fit-'))
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
const budget = await import('../../src/components/mercury-ui/companionBudget.ts')
const { displayWidth } = await import('../../src/components/mercury-ui/glyphs.ts')
const { ALL_CRITTERS } = await import('../../src/components/mercury-ui/sessionAccent.ts')

// ── §1 the budgets ──────────────────────────────────────────────────────────
section('§1 every bank line fits every surface at 120x40 and 100x30')
{
  const lines = words.everyCompanionLine()
  const widest = ALL_CRITTERS.map(c => c.name).reduce((a, b) => (displayWidth(b) > displayWidth(a) ? b : a), '')
  check(`the widest creature name is on the row (${widest}, ${displayWidth(widest)} cells)`, displayWidth(widest) >= 9)
  for (const [cols, rows] of [
    [120, 40],
    [100, 30],
  ] as const) {
    const budgets: Array<[string, number]> = [
      ['deck row', budget.deckRowLineBudget(cols, widest)],
      ['dock line', budget.dockLineBudget(cols)],
      ['hero bubble', budget.heroBubbleLineBudget(cols)],
      ['mini bubble', budget.miniBubbleLineBudget(cols)],
    ]
    for (const [surface, cells] of budgets) {
      const misfits = lines.filter(l => !budget.fitsBudget(l, cells))
      check(`${cols}x${rows} ${surface} (${cells} cells): every line fits (${lines.length} lines)`, misfits.length === 0, misfits.slice(0, 3).join(' | '))
    }
  }
  check('the widest line is ≤ the authoring cap', Math.max(...lines.map(displayWidth)) <= words.MAX_LINE_CELLS)
  check('an over-long line does not fit a 40-cell budget (the negative)', !budget.fitsBudget('x'.repeat(41), 40))
  check('fitsBudget measures display width, not length (a wide glyph counts 2)', !budget.fitsBudget('漢'.repeat(21), 40) && budget.fitsBudget('漢'.repeat(20), 40))
}

// ── §2 the engine ───────────────────────────────────────────────────────────
section('§2 the engine chooses only lines that fit the narrowest surface')
{
  const { publishCompanionTurnAt, resetCompanionSignals } = await import('../../src/utils/cockpit/companionSignals.ts')
  const engine = await import('../../src/utils/cockpit/companionEngine.ts')
  const voice = await import('../../src/utils/cockpit/companionVoice.ts')
  const { switchSession } = await import('../../src/bootstrap/state.ts')
  let now = 1_800_000_000_000
  engine.setCompanionClockForProofs(() => now)
  const tick = (ms: number): void => {
    now += ms
    engine.recomputeCompanionForProofs()
  }
  const longTurn = (): void => {
    publishCompanionTurnAt({ turnLive: true, streaming: false, awaitingPermission: false }, now)
    engine.recomputeCompanionForProofs()
    now += voice.LONG_WORK_MS + 1_000
    publishCompanionTurnAt({ turnLive: false, streaming: false, awaitingPermission: false }, now)
    engine.recomputeCompanionForProofs()
  }
  switchSession('eeeeeeee-0000-4000-8000-000000000001' as never)
  engine.resetCompanionEngineForTests()
  resetCompanionSignals()
  const unsub = engine.subscribeCompanionEngine(() => {})
  // The narrowest mounted surface can give a line 12 cells: nothing fits.
  engine.setCompanionSpeechBudget('proof-narrow', 12)
  check('the engine reports the narrowest budget', engine.companionEngineStatsForProofs().speechBudget === 12)
  tick(voice.TIP_BOOT_QUIET_MS + 1_000)
  check('no session-start tip fits a 12-cell row ⇒ silent', engine.companionEngineSnapshot().quip === null, engine.companionEngineSnapshot().quip?.text)
  tick(voice.VOICE_COOLDOWN_MS)
  longTurn()
  check('a long settle with no fitting line is SILENT (skipped, never cut)', engine.companionEngineSnapshot().quip === null, engine.companionEngineSnapshot().quip?.text)
  check('/companion tip with no fitting tip answers null', engine.requestCompanionTip() === null)
  // A 41-cell row fits the whole bank.
  engine.setCompanionSpeechBudget('proof-narrow', 41)
  const onDemand = engine.requestCompanionTip()
  check('/companion tip with a fitting row answers a tip that fits', onDemand !== null && displayWidth(onDemand) <= 41, onDemand ?? 'null')
  check('the line is on the row', engine.companionEngineSnapshot().quip?.text === onDemand)
  // The row shrinks under the live line: it leaves — never truncated.
  engine.setCompanionSpeechBudget('proof-narrow', 12)
  check('a live line that stops fitting leaves the screen', engine.companionEngineSnapshot().quip === null)
  engine.setCompanionSpeechBudget('proof-narrow', null)
  check('withdrawing the surface restores an unbounded budget', engine.companionEngineStatsForProofs().speechBudget === Number.POSITIVE_INFINITY)
  unsub()
  engine.setCompanionClockForProofs(null)
}

// ── §3 the surfaces ─────────────────────────────────────────────────────────
section('§3 every speaking surface reports a budget and never truncates a line')
{
  const deck = readFileSync(join(ROOT, 'src/components/mercury-ui/DeckCompanion.tsx'), 'utf8')
  const mini = readFileSync(join(ROOT, 'src/components/mercury-ui/MiniCritter.tsx'), 'utf8')
  check('DeckCompanion (full row) reports deckRowLineBudget', /useCompanionSpeechBudget\(budget\)/.test(deck) && /deckRowLineBudget\(/.test(deck))
  check('CompanionSpeechLine (dock) reports dockLineBudget', /dockLineBudget\(/.test(deck))
  check('HeroCompanionBubble reports heroBubbleLineBudget', /heroBubbleLineBudget\(/.test(mini))
  check('MiniCritter bubble reports miniBubbleLineBudget', /miniBubbleLineBudget\(/.test(mini))
  check('no companion line is truncated at render (DeckCompanion)', !/truncateToWidth\([^)]*quip/.test(deck) && !/truncateToWidth\([^)]*line\.text/.test(deck))
  check('no companion line is truncated at render (MiniCritter)', !/truncateToWidth\([^)]*quip/.test(mini) && !/truncateToWidth\([^)]*line\.text/.test(mini))
  check('every paint of a line goes through fitsBudget', (deck.match(/fitsBudget\(/g) ?? []).length >= 2 && (mini.match(/fitsBudget\(/g) ?? []).length >= 2)
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ COMPANION FIT GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
