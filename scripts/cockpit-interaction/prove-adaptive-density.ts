#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-adaptive-density.ts — every size is composed, and
//  "calmer" never means "emptier by accident".
//
//  adaptive behaviour may make the cockpit calmer or richer, but it
//  must not achieve calmness by deleting Mercury's cockpit. So density is a
//  RE-RANKING, not a hiding: the floor (identity + mission board) survives
//  every mode, and what changes is which ambient lane yields first when rows
//  run out — plus how many rows a lane may spend on glanceables.
//
//    §1 the plan table              §2 the activity signal
//    §3 the rail consumes the plan  §4 REAL BINARY: the boundary sweep
//
//  §4 drives ONE boot across both named review boundaries (97↔100 and
//  149↔150) in both directions, with a non-default critter selected, and
//  holds every stage to the acceptance list: no blank or torn frame, the
//  composer present, the SELECTED critter (never a reverted crab), no line
//  that is mainly an ellipsis.
//
//  The guarded gap: helmDensity.ts and cockpitActivity.ts do not exist and
//  the rail's shed order is a literal array.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  densityPlan,
  hintBudget,
  HELM_COMPACT_ROWS,
  HELM_DENSITY_FLOOR,
} from '../../src/utils/helmDensity.ts'
import {
  getCockpitActivity,
  publishCockpitActivity,
  resetCockpitActivityForTests,
  subscribeCockpitActivity,
  type ActivityState,
} from '../../src/utils/cockpit/cockpitActivity.ts'
import { critterDefForKey } from '../../src/utils/cockpit/critterData.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-density-'))
const TALL = 40
const ALL: ActivityState[] = ['calm', 'active', 'waiting', 'review']

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the plan re-ranks; it never empties')
{
  for (const activity of ALL) {
    const plan = densityPlan(activity, TALL)
    t.check(`${activity}: the plan reports its own activity`, plan.activity === activity, plan.activity)
    t.check(
      `${activity}: the floor is never in the shed ladder`,
      !plan.shedOrder.some(s => (HELM_DENSITY_FLOOR as readonly string[]).includes(s)),
      plan.shedOrder.join(' → '),
    )
    t.check(
      `${activity}: at least one next action survives`,
      hintBudget(plan) >= 1,
      `${hintBudget(plan)} hint rows`,
    )
    t.check(
      `${activity}: nothing is both kept and shed`,
      !plan.keep.some(k => plan.shedOrder.includes(k)),
      `keep=[${plan.keep.join(',')}]`,
    )
  }

  const calm = densityPlan('calm', TALL)
  t.check(
    'calm keeps the established shed order behind the ruled workbench card (it yields first — nothing else moves; the party slot left with the seat retirement)',
    calm.shedOrder.join(',') === 'workbench,next,tabula,recent,chat,crew',
    calm.shedOrder.join(','),
  )
  t.check('calm affords the whole authored hint list', hintBudget(calm) >= 6, `${hintBudget(calm)}`)
  t.check('and reads identity as the emphasis', calm.emphasis === 'identity', calm.emphasis)

  const active = densityPlan('active', TALL)
  t.check(
    'a running turn PROTECTS the next action instead of dropping it first',
    active.keep.includes('next') && !active.shedOrder.includes('next'),
    `keep=[${active.keep.join(',')}] shed=[${active.shedOrder.join(',')}]`,
  )
  t.check(
    'and yields the ambient lanes in its place (the workbench card first — the ruled add moves nothing else)',
    active.shedOrder[0] === 'workbench' && active.shedOrder[1] === 'recent',
    active.shedOrder.join(','),
  )
  t.check('with the work as the emphasis', active.emphasis === 'work', active.emphasis)

  const waiting = densityPlan('waiting', TALL)
  t.check(
    'a pending decision drops the hints first after the ruled card — advice yields to the question',
    waiting.shedOrder[0] === 'workbench' && waiting.shedOrder[1] === 'next' && !waiting.keep.includes('next'),
    waiting.shedOrder.join(','),
  )
  t.check('and spends no rows on glanceables', waiting.secondaryRows === 0, `${waiting.secondaryRows}`)
  t.check('naming the decision as the emphasis', waiting.emphasis === 'decision', waiting.emphasis)

  const review = densityPlan('review', TALL)
  t.check('review names its own emphasis', review.emphasis === 'review', review.emphasis)
  t.check(
    'and yields the ambient lanes while the review surface owns the screen',
    review.shedOrder.includes('chat') && review.shedOrder.includes('crew'),
    review.shedOrder.join(','),
  )

  // Height is a hard modifier: a short terminal spends nothing on secondary
  // detail whatever the session is doing — but still shows one next action.
  for (const activity of ALL) {
    const short = densityPlan(activity, HELM_COMPACT_ROWS - 1)
    t.check(`${activity}: a short terminal is compact`, short.compact, `${HELM_COMPACT_ROWS - 1} rows`)
    t.check(`${activity}: and spends no secondary rows`, short.secondaryRows === 0, `${short.secondaryRows}`)
    t.check(`${activity}: keeping its emphasis`, short.emphasis === densityPlan(activity, TALL).emphasis, short.emphasis)
  }
  t.check(
    'a tall terminal is not compact',
    !densityPlan('calm', HELM_COMPACT_ROWS).compact,
    `${HELM_COMPACT_ROWS} rows`,
  )
  t.check(
    'the plan is PURE — same inputs, same plan',
    JSON.stringify(densityPlan('active', TALL)) === JSON.stringify(densityPlan('active', TALL)),
    'deterministic',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — one published activity, subscribed rather than polled')
{
  resetCockpitActivityForTests()
  t.check('a session boots calm', getCockpitActivity() === 'calm', getCockpitActivity())

  let notifications = 0
  const unsubscribe = subscribeCockpitActivity(() => {
    notifications++
  })
  publishCockpitActivity('active')
  t.check('a change publishes', getCockpitActivity() === 'active' && notifications === 1, `${notifications}`)
  publishCockpitActivity('active')
  t.check(
    'an UNCHANGED value notifies nobody — no repaint storm from a re-render storm',
    notifications === 1,
    `${notifications}`,
  )
  publishCockpitActivity('waiting')
  t.check('and a real change does', notifications === 2, `${notifications}`)
  unsubscribe()
  publishCockpitActivity('calm')
  t.check('unsubscribe detaches', notifications === 2, `${notifications}`)
  resetCockpitActivityForTests()
  t.check('the reset seam restores the boot state', getCockpitActivity() === 'calm', getCockpitActivity())
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — the rail consumes the plan; no lane order is written twice')
{
  const rail = readFileSync('src/components/HelmLanesRail.tsx', 'utf8')
  t.check('the rail reads the published activity', rail.includes('useCockpitActivity()'), 'subscribed')
  t.check('and builds the ONE plan', rail.includes('densityPlan(activity'), 'one owner')
  t.check(
    'the shed loop walks the plan, not a literal',
    rail.includes('for (const k of density.shedOrder)'),
    'plan-driven',
  )
  t.check(
    'no hardcoded shed order survives in the rail',
    !rail.includes("['next', 'tabula', 'party', 'recent', 'chat', 'crew']"),
    'single source',
  )
  t.check(
    'the never-shed floor comes from the plan owner',
    rail.includes('HELM_DENSITY_FLOOR'),
    'shared floor',
  )
  t.check(
    'and the hint budget is spent through it, so the intent formula cannot drift',
    rail.includes('Math.min(5 + (mission ? 0 : 1), hintCap)') && rail.includes('hints.slice(0, hintCap)'),
    'formula mirrors the builder',
  )
  const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
  t.check('the REPL publishes all four states', /publishCockpitActivity\(cockpitActivity\)/.test(repl), 'published')
  t.check(
    "and a pending decision outranks running work",
    /isWaitingForApproval[\s\S]{0,40}\? 'waiting'/.test(repl),
    'ranked',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — REAL BINARY: the named boundaries, both directions, one boot')
{
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const home = join(scratch, 'pty-home')
    const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-density'
    spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
      env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
    })
    const out = join(scratch, 'sweep.json')
    // Both review boundaries, crossed in BOTH directions, continuously — the
    // brief's point that static endpoints are insufficient. 97 and 149 are the
    // hysteresis bands (the cockpit and the second rail must HOLD there);
    // every stage is held to the acceptance list.
    const WIDTHS = [100, 97, 96, 100, 150, 149, 144, 150, 120]
    const cfg = {
      cols: 120, rows: 40, total: 320,
      argv: ['node', BIN], out, cwd: process.cwd(),
      resizes: WIDTHS.map((cols, i) => ({ atTick: 80 + i * 16, cols, rows: 40 })),
      // A draft typed BEFORE the sweep: ruling 9 — resizing must retain the
      // draft (and focus, and the selected critter). A sweep over an empty
      // composer could not observe the loss it exists to forbid.
      sends: [
        // THE LANDING RULE: a
        // bare boot lands on the Boot face — ↵ on New Session enters the chat.
        { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
        { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'draft survives' },
      ],
      readyText: 'draft survives', readySettleTicks: 3,
    }
    const cfgPath = join(scratch, 'sweep-cfg.json')
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: FIXTURE_KEY,
        // A NON-DEFAULT critter for the whole sweep: HZ2 left the resize half
        // of critter continuity to this stage, and a reverted crab at any
        // width is the failure it names.
        MERCURY_CRITTER: 'octopus',
        MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      },
      encoding: 'utf8',
      timeout: vshotBudgetMs(240_000),
    })

    type Cell = { c: string }
    type Stage = { cols: number; rows: number; grid: Cell[][] }
    let stages: Stage[] = []
    let finalLines: string[] = []
    try {
      const payload = JSON.parse(readFileSync(out, 'utf8')) as {
        grid: Cell[][]
        stages?: Stage[]
      }
      stages = payload.stages ?? []
      finalLines = payload.grid.map(row => row.map(c => c.c).join(''))
    } catch {
      /* the checks below report the miss */
    }
    t.check('the sweep survived every SIGWINCH', r.status === 0, `exit=${r.status}`)
    t.check(
      'and captured a frame at every geometry it passed through',
      stages.length === WIDTHS.length,
      `${stages.length} of ${WIDTHS.length}`,
    )

    // The FULL authored mark (review finding 7: the bare core ▜▆▛ is
    // byte-identical to dragon's — pre+core+post is what distinguishes).
    const octoDef = critterDefForKey('octopus').mark
    const octopusMark = octoDef.pre + octoDef.core + octoDef.post
    for (const stage of stages) {
      const lines = stage.grid.map(row => row.map(c => c.c).join(''))
      const text = lines.join('\n')
      const label = `${stage.cols}x${stage.rows}`
      t.check(
        `${label}: not a blank or half-painted frame`,
        lines.filter(l => l.trim().length > 0).length >= 8,
        `${lines.filter(l => l.trim().length > 0).length} painted rows`,
      )
      t.check(`${label}: the composer is present`, text.includes('❯'), 'caret')
      t.check(
        `${label}: the SELECTED critter, never a reverted crab`,
        text.includes(octopusMark),
        `expected ${octopusMark}`,
      )
      t.check(
        `${label}: no line is mainly an ellipsis`,
        !lines.some(l => l.trim().length > 0 && l.trim().replace(/[…\s]/g, '').length === 0),
        'no ellipsis-only row',
      )
      t.check(
        `${label}: the draft survives the resize`,
        text.includes('draft survives'),
        'ruling 9',
      )
      t.check(
        `${label}: no dangling box corner`,
        lines.every(
          l =>
            (l.match(/╭/g)?.length ?? 0) === (l.match(/╮/g)?.length ?? 0) &&
            // Review finding 9: a frame torn along its BOTTOM edge balanced
            // the top corners fine — both axes now.
            (l.match(/╰/g)?.length ?? 0) === (l.match(/╯/g)?.length ?? 0),
        ),
        'corners balance per row',
      )
    }
    t.check(
      'and the sweep settles on a live cockpit',
      finalLines.some(l => l.includes('❯')),
      'composer at rest',
    )
  }
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — REAL BINARY, LIVE ACTIVITY: the density pipe at rendered grids')
{
  // §1–§3 prove the TABLE; this proves the PIPE — REPL publisher →
  // cockpitActivity store → densityPlan → rail composition — on real frames
  // (re-audit: the boundary sweep never left calm, so the prover named
  // "adaptive-density" carried no live assertion about density adapting).
  // One boot, three marks: calm (idle, whole authored hint list), active
  // (mid-stream, the budget caps hints at 3, never zero), waiting (a real
  // permission dialog, advice drops to the floor).
  const BIN = 'dist/mercury.mjs'
  if (!existsSync(BIN)) {
    t.check('dist exists (build first)', false, BIN)
  } else {
    const fixture = await startFixtureApi([
      {
        kind: 'paced_tool_use',
        preDeltas: Array.from({ length: 40 }, (_, i) => `chunk-${i} `),
        gapMs: 300,
        // A command the permission classifier can never auto-approve (a write
        // redirect outside the project) — `echo x` alone auto-approves and no
        // dialog ever appears.
        tools: [{ name: 'Bash', input: { command: 'echo audit-probe > /etc/mercury-audit-probe', description: 'density probe' } }],
        whenModel: 'opus',
      },
      { kind: 'text', text: 'finished', whenModel: 'opus' },
      ...Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'ok' })),
    ])
    const home = join(scratch, 'live-home')
    const API_KEY = 'sk-ant-fixture-density-live-00000000000000'
    {
      const seed = spawn(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
        env: { ...process.env, ANTHROPIC_API_KEY: API_KEY },
      })
      await new Promise<void>(resolve => seed.on('exit', () => resolve()))
    }
    const out = join(scratch, 'live-density.json')
    const cfgPath = join(scratch, 'live-density-cfg.json')
    writeFileSync(
      cfgPath,
      JSON.stringify({
        cols: 120, rows: TALL, total: 460,
        argv: ['node', BIN], out, cwd: process.cwd(),
        sends: [
          // THE LANDING RULE (line 4, signed (b)): ↵ on the face's New Session first.
          { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
          { atTick: 90, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: '', mark: 'calm' },
          { afterPrevTicks: 2, data: 'go\r' },
          // No afterPrevTicks here: vshot gives it PRECEDENCE as the hard
          // deadline (if-else over atTick), which fired this mark at
          // prev+10 ≈ tick 20 — the exact edge where the paced stream's
          // first chunks paint. Needle-gated with the generous atTick 200
          // deadline, the mark waits for streaming to really be on screen.
          { atTick: 200, awaitText: 'chunk-5', minTick: 2, awaitSettleTicks: 1, data: '', mark: 'active' },
          { atTick: 420, awaitText: 'Do you want to proceed?', minTick: 5, awaitSettleTicks: 2, data: '', mark: 'waiting' },
          // Dismiss the confirmation card (Esc — its own documented cancel)
          // AFTER the waiting mark has snapshotted it. A card nobody answers
          // keeps waiting, so a journey that parks on one can never reach the
          // idle-composer readyText — the scenario, not the driver, was what
          // made §5 refuse. Ending through the card's real cancel path makes
          // ready honestly reachable, and the refusal stays loud.
          { afterPrevTicks: 2, data: '\u001b' },
        ],
        readyText: '? for shortcuts', readySettleTicks: 4,
      }),
    )
    const child = spawn('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        MERCURY_CONFIG_DIR: home,
        ANTHROPIC_BASE_URL: fixture.url,
        ANTHROPIC_API_KEY: API_KEY,
        MERCURY_BOOT_PREFLIGHT: '0',
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor-live'),
        MERCURY_DAEMON_DIR: join(scratch, 'daemon-live'),
        MERCURY_TEAMS_DIR: join(scratch, 'teams-live'),
        MERCURY_TABULA_DIR: join(scratch, 'tabula-live'),
      },
    })
    let driverOut = ''
    child.stdout.on('data', d => (driverOut += String(d)))
    child.stderr.on('data', d => (driverOut += String(d)))
    // The wall rides the hosted profile (an authored wall killed the
    // stretched capture with status null).
    const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(200_000))
    const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
    clearTimeout(killer)
    await fixture.close()

    type Cell = { c: string }
    let payload: { marks?: { label: string; grid: Cell[][] }[] } = {}
    try {
      payload = JSON.parse(readFileSync(out, 'utf8'))
    } catch {
      /* reported below */
    }
    const gridLines = (label: string): string[] =>
      (payload.marks?.find(m => m.label === label)?.grid ?? []).map(row => row.map(c => c.c).join(''))
    // A NEXT hint row paints as "/command — label" in the rail.
    const hintRows = (lines: string[]): number => lines.filter(l => /\/[a-z]+ — /.test(l)).length

    const calm = gridLines('calm')
    const active = gridLines('active')
    const waiting = gridLines('waiting')
    t.check('the journey completed', status === 0, `exit=${status} ${driverOut.slice(-250)}`)
    t.check(
      'all three activity marks captured',
      calm.length > 0 && active.length > 0 && waiting.length > 0,
      `${payload.marks?.length ?? 0} marks`,
    )
    t.check('CALM: the whole authored hint list paints', hintRows(calm) >= 4, `${hintRows(calm)} hint rows`)
    t.check('ACTIVE: the budget caps the list', hintRows(active) <= 3, `${hintRows(active)} hint rows`)
    t.check('ACTIVE: still teaching — never zero', hintRows(active) >= 1, `${hintRows(active)}`)
    t.check('ACTIVE really was streaming', active.some(l => l.includes('chunk-')), 'stream text on screen')
    t.check('WAITING: advice drops to the floor', hintRows(waiting) <= 1, `${hintRows(waiting)} hint rows`)
    t.check(
      'WAITING really was a decision',
      waiting.some(l => l.includes('Do you want to proceed?')),
      'the dialog is on screen',
    )
  }
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-adaptive-density')
