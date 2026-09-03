#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-concourse-rail.ts — B1: the
//  needs-you rail is a cursor-following WINDOW (the invisible-obligation
//  class is dead).
//
//  The defect this pins closed: the rail rendered slice(0,3) while the
//  screen clamped its selection to the FULL obligation list — ↵ could act
//  on an obligation the operator could not see (operator-safety P1,
//  B1). The fix: paneWindow (the shared cursor-following slice) + an honest
//  header (the count is the TOTAL; ↑N/↓N carry the exact hidden counts on
//  the header line — zero extra height, the chromeRows geometry law).
//
//  Proof shape (render-verify law — a rendered capture, never source grep
//  alone): the REAL dist boots onto the concourse with a 5-obligation
//  fixture (the §8.1 reference snapshot with its needsYou EXTENDED — the
//  frozen reference fixture itself is untouched; its N=1 frame renders
//  byte-identically under this change and stays pinned by the parity
//  prover). The drive walks ↓ four times with OBSERVED-READY sends chained
//  off newly-appearing row titles; assertions FIND the three distinct
//  window states in the grab timeline and prove their order:
//    S0  sel=0: rows 1–3 visible, 4–5 absent, header '· 5' + '↓2', no '↑'
//    S2  sel=2: rows 2–4 visible, 1+5 absent, '↑1' AND '↓1'
//    S3+ sel≥3: rows 3–5 visible, 1+2 absent, '↑2', no '↓'
//  The ↵-target identity closes structurally: the screen acts on
//  needsYou[railIndex], the rail marks selected at win.start+i===railIndex,
//  and paneWindow keeps the selection inside [start,end) (its own standing
//  prover) — so the acted-on row is always the rendered-selected row.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'
import { grabScreens, requireDist, runArtifactArena, type ArenaRun } from '../streaming/artifactArena.ts'
import { displayWidth } from '../../src/components/mercury-ui/glyphs.ts'
import { paneWindow } from '../../src/components/mercury-ui/paneWindow.ts'
import { railTailParts } from '../../src/components/concourse/NeedsYouRail.tsx'
import { referenceFixtureSnapshot } from './concourseReferenceSeed.ts'
import { vshotBudgetMs as S } from '../lib/captureDriver.ts'

const t = checker()
scratchRoot('concourse-rail')
requireDist()

// ── the 5-obligation fixture (reference snapshot, needsYou extended) ────────

const TITLES = ['RAILQONE', 'RAILQTWO', 'RAILQTHREE', 'RAILQFOUR', 'RAILQFIVE'] as const

const fixture = referenceFixtureSnapshot() as { needsYou: unknown; counts: Record<string, unknown> }
fixture.needsYou = TITLES.map((title, i) => ({
  obligationId: `b1-rail-${i + 1}`,
  sessionId: `b1-rail-session-${i + 1}`,
  title,
  question: `rail window walk question ${i + 1}`,
  projectLabel: 'Moodle',
  agentLabel: 'Mercury',
  ageLabel: `${i + 1}m`,
}))
fixture.counts['needsYou'] = 5

const fixtureDir = mkdtempSync(join(tmpdir(), 'concourse-rail-'))
const fixturePath = join(fixtureDir, 'concourse-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))

// ── drive: wake, walk the ring to the rail, then four ↓ presses ─────────────
//  THE RING (the manager-mode grammar
//  is the law): the full stage boots on the COORDINATOR region (its composer
//  is the arrival's printable owner) and Tab cycles coordinator → list →
//  live → rail. The old drive assumed a board-focused boot and pressed
//  shift-tab "back to the rail" — on the coordinator region shift-tab is
//  the MANAGER-MODE toggle, not a ring step, so the ↓ walk never reached
//  the rail (S2/S3+ "never seen" on main and on the control tree alike).
//  Three Tabs reach the rail; the wake space lands in the coordinator
//  draft (invisible) and absorbs the idle-parked first-keypress eat; the
//  first two ↓ anchor on RAILQONE (the settled INITIAL paint — full-frame,
//  needle-atomic). Every run here passes anchor: null — the arena's chat
//  anchor ('Type a prompt') never paints on a concourse boot and would hold
//  every fixed-ms send past 4000 ms forever.
//  THE AFTER-NEEDLE DIFF-ATOMICITY LAW (learned here): a needle must be
//  text the renderer writes in ONE run — the row titles share the RAILQ
//  prefix, so a title replacing its predecessor never reaches the byte
//  stream whole (the differ skips the common cells and writes 'FOUR', not
//  'RAILQFOUR'). The later ↓s therefore chain off the rail HEADER
//  indicators, which replace DIFFERENT glyphs at their cells and must be
//  written whole: '↑1' first exists at sel=2, '↑2' first exists at sel=3.
//  (Screen-level assertions below stay title-based: pyte replays the FULL
//  stream, immune to diff granularity.)

const run: ArenaRun = await runArtifactArena({
  turns: [],
  sends: [
    'after:RAILQONE:1200: ',
    // The full stage boots on the coordinator region: Tab → list → live →
    // rail (three steps) before the ↓ walk drives the rail's window.
    'after:RAILQONE:1800:\t',
    'after:RAILQONE:2400:\t',
    'after:RAILQONE:3000:\t',
    'after:RAILQONE:3800:\x1b[B',
    'after:RAILQONE:4600:\x1b[B',
    'after:↑1:800:\x1b[B',
    'after:↑2:800:\x1b[B',
  ],
  seconds: 16,
  cols: 142,
  rows: 38,
  keep: true,
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(fixtureDir, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir, 'crew'),
  },
})

try {
  const offsets: number[] = []
  // The ladder rides the movie knob (the §5 ladder below already did; this
  // one was the straggler — raw ms read the first third of a stretched run).
  for (let ms = S(2500); ms <= S(15500); ms += S(400)) offsets.push(ms)
  offsets.push(-1)
  const grabs = grabScreens(run, 142, 38, offsets)

  interface RailView {
    atMs: number
    railLine: string
    titlesOn: Set<string>
  }
  const views: RailView[] = grabs.map(g => {
    const railLine = g.rows.find(r => r.includes('NEEDS YOU')) ?? ''
    const text = g.rows.join('\n')
    return {
      atMs: g.atMs,
      railLine,
      titlesOn: new Set(TITLES.filter(x => text.includes(x))),
    }
  })

  const stateOf = (v: RailView, on: string[], off: string[]): boolean =>
    on.every(x => v.titlesOn.has(x)) && off.every(x => !v.titlesOn.has(x))

  const s0 = views.find(
    v => stateOf(v, ['RAILQONE', 'RAILQTWO', 'RAILQTHREE'], ['RAILQFOUR', 'RAILQFIVE']) && v.railLine !== '',
  )
  const s2 = views.find(
    v => stateOf(v, ['RAILQTWO', 'RAILQTHREE', 'RAILQFOUR'], ['RAILQONE', 'RAILQFIVE']) && v.railLine !== '',
  )
  const s3 = views.find(
    v => stateOf(v, ['RAILQTHREE', 'RAILQFOUR', 'RAILQFIVE'], ['RAILQONE', 'RAILQTWO']) && v.railLine !== '',
  )

  // A missed state must carry its own evidence: the compact per-grab
  // timeline (titles on screen + the rail header line) IS the diagnostic,
  // and the drive record answers WHICH sends actually fired and WHEN each
  // needle first hit the byte stream.
  if (!s0 || !s2 || !s3) {
    for (const v of views) {
      console.log(
        `    [view] @${v.atMs} [${TITLES.filter(x => v.titlesOn.has(x)).map(x => x.slice(5)).join(',')}] ${v.railLine.trim().slice(0, 60)}`,
      )
    }
    let streamStart: number | undefined
    const seenAt = new Map<string, number>()
    for (const line of readFileSync(run.paths.drive, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as { ts?: number; b64?: string; sent?: number; after?: string; atMs?: number }
        if (typeof e.sent === 'number') {
          console.log(`    [sent] atMs=${e.atMs} after=${e.after ?? '(fixed)'} payload=${JSON.stringify(Buffer.from(e.b64 ?? '', 'base64').toString('latin1'))}`)
        } else if (typeof e.ts === 'number' && typeof e.b64 === 'string') {
          streamStart ??= e.ts
          const text = Buffer.from(e.b64, 'base64').toString('latin1')
          for (const n of TITLES) {
            if (!seenAt.has(n) && text.includes(n)) seenAt.set(n, e.ts - streamStart)
          }
        }
      } catch {
        /* torn tail */
      }
    }
    console.log(`    [needles-in-stream] ${TITLES.map(n => `${n.slice(5)}@${seenAt.get(n) ?? 'never'}`).join(' ')}`)
  }

  t.section('§1 — the window follows the cursor (three distinct rendered states)')
  t.check('S0 (sel=0): rows 1–3 painted, 4–5 genuinely hidden', s0 !== undefined, s0 ? `@${s0.atMs}` : 'never seen')
  t.check('S2 (sel=2): the window advanced — rows 2–4, row 1 scrolled out', s2 !== undefined, s2 ? `@${s2.atMs}` : 'never seen')
  t.check('S3+ (sel≥3): the tail window — rows 3–5, rows 1–2 out', s3 !== undefined, s3 ? `@${s3.atMs}` : 'never seen')
  t.check(
    'the states appear in walk order (S0 → S2 → S3+)',
    s0 !== undefined && s2 !== undefined && s3 !== undefined && s0.atMs < s2.atMs && s2.atMs < s3.atMs,
    `${s0?.atMs} < ${s2?.atMs} < ${s3?.atMs}`,
  )

  t.section('§2 — the header is honest (total + exact hidden counts, rail line only)')
  t.check('S0 header: total 5, ↓2 below, nothing above', s0 !== undefined && s0.railLine.includes('· 5') && s0.railLine.includes('↓2') && !s0.railLine.includes('↑'), s0?.railLine.trim() ?? '')
  t.check('S2 header: ↑1 AND ↓1 (one hidden each side)', s2 !== undefined && s2.railLine.includes('↑1') && s2.railLine.includes('↓1'), s2?.railLine.trim() ?? '')
  t.check('S3+ header: ↑2, nothing below', s3 !== undefined && s3.railLine.includes('↑2') && !s3.railLine.includes('↓'), s3?.railLine.trim() ?? '')
  t.check(
    'the total stays 5 in every matched state',
    [s0, s2, s3].every(v => v !== undefined && v.railLine.includes('· 5')),
  )

  t.section('§3 — the ↵-target identity (structural: acted row == rendered-selected row)')
  const screenSrc = readFileSync(join(import.meta.dir, '../../src/components/concourse/ConcourseScreen.tsx'), 'utf8')
  const railSrc = readFileSync(join(import.meta.dir, '../../src/components/concourse/NeedsYouRail.tsx'), 'utf8')
  // R7 C-MED-5 moved the acted index to the SYNCHRONOUS cursor (liveRailIdx
  // — derived from railSelRef against the same FULL list) so a burst's ↵
  // acts on the row the walk reached; the identity law itself is unchanged.
  t.check('the screen acts on needsYou[liveRailIdx()] (the FULL-list synchronous index)', screenSrc.includes('snapshot.needsYou[liveRailIdx()]'))
  t.check('the rail renders the paneWindow slice of the SAME list', railSrc.includes('snapshot.needsYou.slice(win.start, win.end)'))
  t.check('the rail marks selected at the absolute index', railSrc.includes('selected={win.start + i === selectedIndex}'))
  // A1 (total-allocation budget): the rail's window rides the
  // shared allocator's band — RAIL_MAX_ROWS stays the load-bearing cap,
  // clamped into the granted maxRows (NeedsYouRail.tsx).
  t.check('the rail windows through the shared paneWindow owner (budget-clamped, RAIL_MAX_ROWS-capped)', railSrc.includes('paneWindow(total, selectedIndex, Math.max(1, Math.min(RAIL_MAX_ROWS, maxRows)))'))

  t.section('§4 — window math spot pins (the shared fn answers what §1 rendered)')
  const w4 = paneWindow(5, 4, 3)
  t.check('paneWindow(5,4,3) = rows 3–5, two hidden above', w4.start === 2 && w4.end === 5 && w4.above === 2 && w4.below === 0)
  const w0 = paneWindow(5, 0, 3)
  t.check('paneWindow(5,0,3) = rows 1–3, two hidden below', w0.start === 0 && w0.end === 3 && w0.above === 0 && w0.below === 2)
  const w1 = paneWindow(1, 0, 3)
  t.check('degenerate N=1: no hidden rows, no indicators (the frozen §8.1 frame — parity prover pins the render)', w1.above === 0 && w1.below === 0 && w1.end === 1)
} finally {
  run.cleanup()
  rmSync(fixtureDir, { recursive: true, force: true })
}

// ── §5/§6 — B5 (D2): the composer echo (burst integrity + clear-beats-echo) ─
//  LIVE mode (no fixture — a fixture snapshot is frozen at mount, so the
//  reconcile under test would never see a transition): the empty concourse
//  boots on the real builder with the COORDINATOR composer as the
//  arrival's printable owner (the two-composers grammar of 08-28 retired
//  the whole-screen composer strip and its 'n' door — the old drive's
//  needle "start one — type in the composer" never paints again, so its
//  'n' never fired and the burst was never typed on main or on the
//  control); a 20-char burst types at 30 ms cadence straight into it,
//  chained off the pane's COORDINATOR header (time IS the contract for a
//  burst — the retired store-round-trip echo provably dropped characters
//  at this rate), then an EXTERNAL store clear (the dispatch-receipt twin,
//  written by this prover mid-run) reaches the app on the route's poll
//  rebuild and must beat the local echo within one reconcile.

const BURST = 'concourse rail echo!'
const fixtureDir2 = mkdtempSync(join(tmpdir(), 'concourse-echo-'))

let sidecarState = 'never-fired'
const erun: ArenaRun = await runArtifactArena({
  turns: [],
  seedHome: configDir => {
    // THE CLEAR FOLLOWS THE BURST, NEVER A WALL CLOCK: the sends ride drive
    // ticks (stretched under the hosted profile) while a timer here ran on
    // wall clock from seedHome (pre-boot) — on a slow hosted boot the clear
    // landed BEFORE the burst was typed, so the burst stood to the end and
    // "the clear happened after the burst held" was unprovable. The app
    // persists the coordinator draft as it is typed; the sidecar polls
    // that file, and only once the WHOLE burst is on disk (the burst held)
    // waits one stretched beat and writes the foreign clear. The wall-clock
    // fallback stays for a world that never persists the burst, so the
    // arena can never wait forever.
    const draftPath = join(configDir, 'concourse-draft.json')
    let fired = false
    const fire = (why: string): void => {
      if (fired) return
      fired = true
      try {
        writeFileSync(draftPath, JSON.stringify({ draft: '', updatedAtMs: Date.now() }))
        sidecarState = `fired@${new Date().toISOString().slice(11, 19)} (${why})`
      } catch (e) {
        sidecarState = `write-failed: ${e}`
      }
    }
    const poll = setInterval(() => {
      let onDisk = ''
      try {
        onDisk = readFileSync(draftPath, 'utf8')
      } catch {
        return
      }
      if (!onDisk.includes(BURST)) return
      clearInterval(poll)
      const beat = setTimeout(() => fire('the burst persisted'), S(1_500))
      ;(beat as { unref?: () => void }).unref?.()
    }, 250)
    ;(poll as { unref?: () => void }).unref?.()
    const fallback = setTimeout(() => {
      clearInterval(poll)
      fire('wall-clock fallback')
    }, S(18_000))
    ;(fallback as { unref?: () => void }).unref?.()
  },
  // Re-shaped: NO submit — the drive rulings made ↵ CONSUME the
  // draft into a queued dispatch row (held + noted), so the retired
  // "refused submit keeps the draft" flow does not exist to observe (the
  // dispatch hold laws are prove-concourse-dispatch's). This arena proves
  // the two composer laws that survive: the burst echoes COMPLETELY, and a
  // FOREIGN store clear beats the standing local echo (D2 §4b).
  sends: [
    // The wake space absorbs the idle-parked first-keypress eat (it lands
    // in the coordinator draft, invisible); the burst follows at 30 ms.
    'after:COORDINATOR:1500: ',
    ...BURST.split('').map((ch, i) => `after:COORDINATOR:${2500 + i * 30}:${ch}`),
  ],
  // Past the route's 15 s poll: the FOREIGN-process clear (this prover's
  // sidecar) reaches the app on the poll rebuild — the in-process clear
  // (the real dispatch receipt) rides the store subscription immediately;
  // the reconcile law under test is the same either way.
  seconds: 23,
  cols: 142,
  rows: 38,
  keep: true,
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: join(fixtureDir2, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir2, 'crew'),
  },
})

try {
  const offsets: number[] = []
  for (let ms = S(4000); ms <= S(22000); ms += S(400)) offsets.push(ms)
  const grabs = grabScreens(erun, 142, 38, offsets)
  const withBurst = grabs.filter(g => g.rows.some(r => r.includes(BURST)))
  // Cleared: the burst gone while the coordinator pane still stands (the
  // composer at rest again — never a blank frame or a lost pane).
  const cleared = grabs.filter(
    g => !g.rows.some(r => r.includes(BURST)) && g.rows.some(r => r.includes('COORDINATOR')),
  )

  t.section('§5 — the 30ms burst echoes COMPLETELY (rendered == typed)')
  t.check('the full 20-char burst painted in the strip', withBurst.length > 0, withBurst[0] ? `@${withBurst[0].atMs}` : 'never seen')

  t.section('§6 — an external store clear beats the local echo (D2 §4b)')
  const lastBurst = withBurst[withBurst.length - 1]
  const firstCleared = cleared.find(g => lastBurst !== undefined && g.atMs > lastBurst.atMs)
  t.check('the echo yielded to the store clear (burst gone, placeholder back)', firstCleared !== undefined, firstCleared ? `@${firstCleared.atMs}` : `cleared grabs: ${cleared.map(g => g.atMs).join(',') || 'none'}`)
  t.check(
    'the clear happened AFTER the burst held (order proven)',
    lastBurst !== undefined && firstCleared !== undefined && lastBurst.atMs < firstCleared.atMs,
    `${lastBurst?.atMs} < ${firstCleared?.atMs}`,
  )
} finally {
  try {
    const draftOnDisk = readFileSync(join(erun.paths.home, '.claude', 'concourse-draft.json'), 'utf8')
    console.log(`    [sidecar] ${sidecarState} · draft file at run end: ${draftOnDisk.slice(0, 120)}`)
  } catch (e) {
    console.log(`    [sidecar] ${sidecarState} · draft file unreadable: ${e}`)
  }
  erun.cleanup()
  rmSync(fixtureDir2, { recursive: true, force: true })
}

// ── §7 — valve renders: the PAUSED group + the redirect-compose strip ─
//  The reference fixture gains ONE paused row (the §8.1 frozen frame is a
//  DIFFERENT fixture file — untouched); Tab moves rail→board (the board's
//  initial selection is the reference peek: a WORKING row), 'r' opens the
//  redirect composer, and the strip must speak the target.

const fixture3 = referenceFixtureSnapshot() as { groups: Array<Record<string, unknown>> }
fixture3.groups.push({
  id: 'paused',
  label: 'PAUSED',
  rows: [
    {
      sessionId: 'sess-pz',
      title: 'PAUSEDROWQ',
      state: 'paused',
      projectLabel: 'Moodle',
      ownerLabel: null,
      ageLabel: '9m',
      seats: null,
    },
  ],
})
const fixtureDir3 = mkdtempSync(join(tmpdir(), 'concourse-valve-'))
const fixturePath3 = join(fixtureDir3, 'concourse-fixture.json')
writeFileSync(fixturePath3, JSON.stringify(fixture3))

const vrun: ArenaRun = await runArtifactArena({
  turns: [],
  // The populated board boots FOCUSED — no region tab needed; the
  // wake space absorbs the idle-parked first-keypress eat, then 'r' opens
  // the redirect composer for the selected (reference peek) row.
  // Rows 38→52: the board WINDOWS by design — at 38 rows the
  // 8-row fixture folds behind '↓ N more' and the PAUSED group (last) never
  // paints, so the observed-ready sends never fire. 52 rows hold the whole
  // fixture; the law under test (the valve is VISIBLE) is height-neutral.
  // Walk BLIND to the tail: the switchboard board WINDOWS by
  // ruled design, so the appended PAUSED group starts below the fold —
  // waiting to SEE it before walking was a chicken-and-egg that never
  // fired. The ↓ walk scrolls the selection-follow window until the tail
  // group paints; then 'r' opens the redirect composer on a live row.
  // ↓ browses from ANY region (the base legend's law) — the walk scrolls
  // the selection-follow window until the tail PAUSED group paints.
  sends: [
    'after:Audit billing receipts:1200: ',
    ...[1800, 2200, 2600, 3000, 3400, 3800, 4200, 4600].map(ms => `${ms}:\x1b[B`),
  ],
  seconds: 9,
  cols: 142,
  rows: 52,
  keep: true,
  anchor: null,
  extraEnv: {
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath3,
    MERCURY_DAEMON_DIR: join(fixtureDir3, 'daemon'),
    MERCURY_CREW_DIR: join(fixtureDir3, 'crew'),
  },
})

try {
  const grabs = grabScreens(vrun, 142, 52, [S(2000), S(3400), S(4200), S(5000), S(6000), S(7000), -1])
  const anyFrame = grabs.find(g => g.rows.some(r => r.includes('PAUSEDROWQ')))
  t.section('§7 — the valve is VISIBLE (paused group + redirect compose)')
  t.check('the PAUSED group header renders on the board', anyFrame !== undefined && anyFrame.rows.some(r => r.includes('PAUSED') && !r.includes('PAUSEDROWQ')), anyFrame ? `@${anyFrame.atMs}` : 'never')
  // The 'r' redirect composer RETIRED with the switchboard recomposition
  // (messaging a session rides the composer targeting / the coordinator /
  // entering the session) — the affordance check retires with it as a
  // named deletion (the class); the valve VISIBILITY law above is
  // the surviving half.
} finally {
  vrun.cleanup()
  rmSync(fixtureDir3, { recursive: true, force: true })
}

// ── §8 — B2: the row tail sheds METADATA before AFFORDANCES ─────────────────
//  Pure legs over the exported railTailParts (the component consumes the
//  same fn — §3-style source pin below). The old wrap="truncate-end" ate
//  the affordances FIRST (rightmost); the shed law inverts that: a row the
//  operator can still act on keeps saying HOW.
{
  t.section('§8 — B2: the tail sheds meta first, answer & resume survives last')
  const o = { projectLabel: 'Moodle', agentLabel: 'Mercury', ageLabel: '3m' }
  const joined = (parts: ReturnType<typeof railTailParts>): string => parts.map(p => p.text).join('')
  const full = railTailParts(o, 500)
  // Re-pinned (operator finding 3, drive-5): the tail gained the
  // ✕ dismiss affordance (priority 3.5 — outranks 'open' in the shed) and
  // retired the agent-handle meta segment. Four parts now; the B2 law
  // (meta sheds first, 'answer & resume' survives last) is unchanged.
  t.check('all four parts fit a generous budget, display order kept', full.map(p => p.key).join(',') === 'meta,answer,open,dismiss')
  t.check(
    'the full-fit join is the band-aligned composition (R3 restoration: the meta cluster stands alone at its band — no leading joiner)',
    joined(full) === 'Moodle · 3m │ answer & resume │ open session │ ✕ dismiss',
    JSON.stringify(joined(full)),
  )
  const fullW = displayWidth(joined(full))
  const oneShy = railTailParts(o, fullW - 1)
  t.check('one cell shy: META drops first, every affordance survives', oneShy.map(p => p.key).join(',') === 'answer,open,dismiss', joined(oneShy))
  const affordW = displayWidth(joined(oneShy))
  const openYields = railTailParts(o, affordW - 1)
  t.check("next: OPEN yields — dismiss + 'answer & resume' outrank it", openYields.map(p => p.key).join(',') === 'answer,dismiss', joined(openYields))
  const dismissW = displayWidth(joined(openYields))
  const answerOnly = railTailParts(o, dismissW - 1)
  t.check("last: 'answer & resume' is the final survivor", answerOnly.map(p => p.key).join(',') === 'answer', joined(answerOnly))
  t.check('a hopeless budget sheds everything whole (no half-truncated affordance)', railTailParts(o, 3).length === 0)
  const railSrc2 = readFileSync(join(import.meta.dir, '../../src/components/concourse/NeedsYouRail.tsx'), 'utf8')
  // Re-pinned: the call gained its third argument (the cross-project
  // door line's own tail shape — o.foreignProject) after the pin was cut;
  // the budget expression is the law, the argument list is the spelling.
  t.check('the component renders the SAME fn against the real remaining budget', railSrc2.includes('railTailParts(o, Math.max(0, width - 4 - titleBand - questionBand), o.foreignProject !== undefined)'))
}

t.finish('prove-concourse-rail')
