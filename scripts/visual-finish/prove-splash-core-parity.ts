#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-finish/prove-splash-core-parity.ts — after
//  the share-by-extraction split, splash↔canonical parity holds by
//  CONSTRUCTION, and THIS prover pins the construction:
//
//    §1 STRUCTURE — exactly one helmet/WORD grid owner in the tree
//       (assets/splash/splash-core.mjs); BOTH hosts import the one core
//       (the standalone driver via './splash-core.mjs', the in-process Boot
//       face via createSplashCore), and neither host rewrites a grid or a
//       second compose.
//    §2 PURITY — the core imports side-effect-free and reads no ambient
//       process/env/tty state (the injection seam is createSplashCore +
//       composeLockup opts).
//    §3 FLATTEN PARITY — at 80x24 · 100x34 · 142x38 AND the operator-scale
//       205x53 profile, every composed line of the IN-PROCESS composition
//       round-trips the Ink run adapter losslessly: the parser accepts the
//       core's complete SGR vocabulary (a new emitter kind REDS here instead
//       of silently dropping paint), text is byte-preserved, and re-emitting
//       the runs re-parses to the identical run list — so the adapter's cell
//       output equals the driver's SGR flatten for the same composed lines.
//    §4 GROUND LAW (CB-11 · round-7 flat ground + the round-5 plate) —
//       background ink appears only inside rasterHard's half-block art cells
//       and as the PLATE_TONE (== GROUND, round 8) on boxed chrome lines; the
//       rule/hint lines are fg-only and NO field/vignette background exists
//       (the scene rides the flat estate ground).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { parseSplashRuns, type SplashRun } from '../../src/components/mercury-ui/splashRuns.ts'
import { createSplashCore, assembleCardRows } from '../../assets/splash/splash-core.mjs'

const t = checker()
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

const coreSrc = read('assets/splash/splash-core.mjs')
const driverSrc = read('assets/splash/mercury-splash.mjs')
const faceSrc = read('src/components/BootSplashScreen.tsx')

t.section('§1 — one grid owner, two consuming hosts (share-by-extraction)')
{
  t.check(
    'the helmet + WORD grids live in the core (baked markers present)',
    coreSrc.includes('HEADSTD-GRID-START') && coreSrc.includes('WORD-GRID-START'),
    'core markers',
  )
  t.check(
    'the driver carries NO grid of its own (the extraction is complete)',
    !driverSrc.includes('HEADSTD-GRID-START') && !driverSrc.includes('WORD-GRID-START') && !driverSrc.includes('const HEADSTD ='),
    'driver grid-free',
  )
  t.check(
    "the driver imports the one core ('./splash-core.mjs') and composes through composeLockup",
    driverSrc.includes("from './splash-core.mjs'") && driverSrc.includes('composeLockup(cols, rows, {'),
    'driver host',
  )
  t.check(
    'the in-process Boot face consumes createSplashCore + composeLockup (never a hand-authored sibling)',
    faceSrc.includes('createSplashCore') && faceSrc.includes('composeLockup') && !faceSrc.includes('BigWordmark') && !faceSrc.includes('CritterArt'),
    'face host',
  )
  t.check(
    'no second rasterHard exists outside the core (one raster owner)',
    !driverSrc.includes('function rasterHard') && !faceSrc.includes('rasterHard('),
    'raster census',
  )
  // the census grows — ONE row-data assembly, ONE strip grammar,
  // ONE boot-menu composition, consumed by BOTH hosts.
  t.check(
    'both hosts assemble the ORIGINAL card through core assembleCardRows',
    driverSrc.includes('assembleCardRows({') && faceSrc.includes('assembleCardRows({') && coreSrc.includes('export function assembleCardRows'),
    'one card-data owner',
  )
  t.check(
    'both hosts emit the strip through core composeStrip (no second strip grammar)',
    driverSrc.includes('coreComposeStrip(') && faceSrc.includes('composeStrip(') && !driverSrc.includes('const fitRow'),
    'one strip owner',
  )
  t.check(
    'both hosts compose the boot menu through core composeBootMenu (no second three-panel)',
    driverSrc.includes('coreComposeBootMenu(') &&
      read('src/components/BootSettingsScreen.tsx').includes('composeBootMenu(') &&
      !driverSrc.includes('function composeMenuWide'),
    'one menu owner',
  )
}

t.section('§2 — the core is pure (injection-only capability + data)')
{
  t.check(
    'the core reads NO ambient process state (no process. / import of node builtins)',
    !/\bprocess\./.test(coreSrc) && !/from 'node:/.test(coreSrc) && !/require\(/.test(coreSrc),
    'ambient-free',
  )
  const mod = createSplashCore({ nocolor: false, truecolor: true })
  t.check('createSplashCore yields the compose surface', typeof mod.composeLockup === 'function' && typeof mod.placeBlock === 'function', 'factory shape')
  const plain = createSplashCore({ nocolor: true, truecolor: true })
  t.check(
    'the nocolor binding emits ZERO styling bytes (layout-identical plain path)',
    plain.R === '' && plain.hexFg('#DD4444', 167) === '' && plain.BOLD === '',
    'plain law',
  )
}

t.section('§3 — flatten parity at the capture matrix (incl. the operator profile)')
{
  const core = createSplashCore({ nocolor: false, truecolor: true })
  // the in-process face mirrors the ORIGINAL card — seven rows plus
  // the MCPs & Skills row (after Boot Menu, every world)
  // — + the live strip through the shared assembly — the full presence set
  // so the parity matrix exercises every row shape.
  const IN_PROCESS_OPTS = {
    cardRows: assembleCardRows({
      cwdBase: 'orchard-src',
      continueTarget: { base: 'orchard-src', ageMs: 5 * 60000, cross: false },
      menuAvailable: true,
      concourse: { ctx: 'the live board · 2 live' },
      projects: [
        { base: 'moodle', ageMs: 60 * 60000 },
        { base: 'avs2', ageMs: 3 * 86400000 },
      ],
    }),
    cardSel: 0,
    hintSegments: [
      { key: '↵ ', label: 'start', tone: 'ivory' as const },
      { key: 'm', label: ' menu', tone: 'faint' as const },
    ],
    tinyHint: '↵ start',
    stripLines: (w: number) =>
      core.composeStrip(
        {
          model: 'Opus 5',
          critter: 'Octopus',
          critterHue: '#B07BE0',
          dir: 'orchard-src',
          acct: { state: 'email', text: 'operator@example.com' },
          health: { verdict: 'certified', age: '2h' },
        },
        w,
      ),
  }
  const SGR = /\x1b\[[0-9;]*m/g
  const emit = (runs: SplashRun[]): string =>
    runs
      .map(r => {
        let s = '\x1b[0m'
        if (r.bold) s += '\x1b[1m'
        if (r.dim) s += '\x1b[2m'
        if (r.underline) s += '\x1b[4m'
        if (r.fg) s += `\x1b[38;2;${parseInt(r.fg.slice(1, 3), 16)};${parseInt(r.fg.slice(3, 5), 16)};${parseInt(r.fg.slice(5, 7), 16)}m`
        if (r.bg) s += `\x1b[48;2;${parseInt(r.bg.slice(1, 3), 16)};${parseInt(r.bg.slice(3, 5), 16)};${parseInt(r.bg.slice(5, 7), 16)}m`
        return s + r.text
      })
      .join('')
  for (const [cols, rows] of [[80, 24], [100, 34], [142, 38], [205, 53]] as const) {
    const res = core.composeLockup(cols, rows, IN_PROCESS_OPTS)
    let vocabOk = true
    let textOk = true
    let roundtripOk = true
    for (const line of res.lines) {
      let runs: SplashRun[]
      try {
        runs = parseSplashRuns(line)
      } catch {
        vocabOk = false
        continue
      }
      if (runs.map(r => r.text).join('') !== line.replace(SGR, '')) textOk = false
      const reparsed = parseSplashRuns(emit(runs))
      if (JSON.stringify(reparsed) !== JSON.stringify(runs)) roundtripOk = false
    }
    t.check(`${cols}x${rows}: the adapter accepts the core's complete SGR vocabulary`, vocabOk, 'closed vocabulary')
    t.check(`${cols}x${rows}: run text is byte-preserved (no dropped cells)`, textOk, 'lossless text')
    t.check(`${cols}x${rows}: emit→reparse is a fixed point (cell output ≡ SGR flatten)`, roundtripOk, 'round-trip stable')
    // RE-PINNED at the kit-design tail fold: the card grew the Saturn row
    // and the logins recut swapped project+resume for
    // Sessions·Projects and added Logins — nine rows then; the agent
    // studio re-home added the Agents row under MCPs & Skills, so
    // the full-world card is TEN action rows now; this count moves ONLY when
    // a card-row fold moves it, with the moving fold named here.
    t.check(
      `${cols}x${rows}: the composition carries the ten action rows (the kit-era eight + Saturn + Agents, post the sessions-projects merge and the Logins row)`,
      res.cardShown && res.actionLines.length === 10,
      `cardShown=${String(res.cardShown)} actions=${res.actionLines.length}`,
    )
  }
}

t.section('§4 — CB-11: background ink is art cells + the approved plate only (no field paint)')
{
  const core = createSplashCore({ nocolor: false, truecolor: true })
  const res = core.composeLockup(142, 38, {
    cardRows: assembleCardRows({
      cwdBase: 'proj',
      continueTarget: null,
      menuAvailable: true,
      concourse: { ctx: 'the live board' },
      projects: [],
    }),
    cardSel: 0,
    hintSegments: [{ key: '↵ ', label: 'start', tone: 'ivory' as const }],
    tinyHint: '↵ start',
    // The strip rides the census too: its lines must stay fg-only (CB-11).
    stripLines: (w: number) =>
      core.composeStrip(
        { model: 'Opus 5', critter: 'Crab', critterHue: '#DD4444', dir: 'proj', acct: { state: 'none' }, health: null },
        w,
      ),
  })
  const offenders: number[] = []
  const PLATE = '\x1b[48;2;13;24;27m' // PLATE_TONE == GROUND (round 8: panels ride the one flat ground)
  res.lines.forEach((line, i) => {
    if (!line.includes('\x1b[48;2;')) return
    // bg is legal on half-block art lines (rasterHard's mixed pair) and on
    // boxed chrome riding the ONE approved plate (round 5; pinned §6c of
    // prove-ramp-parity). Any OTHER bg — a vignette cell, a stray slab —
    // is the field-paint class round 7 retired.
    if (/[▀▄█]/.test(line)) return
    const nonPlate = line.split('\x1b[48;2;').slice(1).some(seg => !('\x1b[48;2;' + seg).startsWith(PLATE))
    if (nonPlate || !/[╭╮╰╯─│├┤]/.test(line)) offenders.push(i)
  })
  t.check(
    'every bg-carrying line is half-block art or PLATE_TONE boxed chrome (no field paint)',
    offenders.length === 0,
    offenders.length === 0 ? 'ground-free' : `non-art/non-plate bg at lines ${offenders.join(',')}`,
  )
}

t.finish('prove-splash-core-parity')
