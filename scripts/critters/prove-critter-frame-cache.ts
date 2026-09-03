#!/usr/bin/env bun
// ============================================================================
//  scripts/critters/prove-critter-frame-cache.ts — the painter's FRAME CACHE
//  and the effective sway phase: an edge of the shared clock that moves no
//  cell costs the reconciler nothing, and every frame is byte-identical to
//  a cache-less render.
//
//  §1  ROOT IDENTITY — the same inputs hand React the SAME root element
//      (a hit is the object the miss built), across every critter × form.
//  §2  LINE REUSE — a sway step on the flowing hero keeps the resting lines'
//      element identity and rebuilds the moving lines only; a blink rebuilds
//      the eye line alone; a still critter's sway steps return the same
//      root; the settle alternates between two roots.
//  §3  BYTE-IDENTITY — every frame in the matrix renders the same bytes
//      (plain + truecolour ANSI) through a hit as through a miss, and the
//      same as a cache-less render (a fresh def object has no cache entry).
//  §4  BOUNDS — a whole sway × blink × sleep cycle on every def stays under
//      the caps inside ONE paint context (a blink never cold-starts the
//      cache); a def painted in more contexts than the cap cold-starts
//      rather than growing.
//  §5  THE EFFECTIVE SWAY PHASE — for every def × form × verdict × phase the
//      painter's bytes at the raw phase equal its bytes at the effective
//      phase; a still critter folds to 0, a settling one to {0, the settle
//      phase}, a flowing one keeps the phase, a sleeping pose keeps parity.
//  §6  THE GAZE MEMOS — cluster discovery and content bounds answer the
//      same object for the same grid and the same VALUES as a fresh scan.
//  §7  SOURCE LOCKS — the view feeds the painter the effective phase; the
//      painter's cache is keyed by the def object (the def-identity rule).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'critter-frame-cache-'))
// Truecolour escapes off-TTY so the ANSI legs compare every fg/bg byte.
process.env['FORCE_COLOR'] = '3'
delete process.env['NO_COLOR']
process.env['MERCURY_CRITTER_GAZE'] = '0'

const t = checker()
const cd = await import('../../src/utils/cockpit/critterData.js')
const gz = await import('../../src/utils/cockpit/critterGaze.js')
const idle = await import('../../src/utils/cockpit/critterIdle.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToString, renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { CritterArt, critterFrameCacheStatsForProofs } = await import('../../src/components/mercury-ui/CritterArt.js')

type Def = (typeof cd.CRITTERS)[number]
type Form = 'hero' | 'art' | 'mini'
type Props = Record<string, unknown>
type El = { type: unknown; props: { children?: unknown } }

// The memo's inner function — the pure painter, callable without a React
// tree (it uses no hooks), so element IDENTITY can be asserted directly.
const paint = (CritterArt as unknown as { type: (p: Props) => El }).type
const linesOf = (root: El): El[] => (root.props.children as El[]) ?? []
const defFor = (def: Def, form: Form): Def => (form === 'mini' ? { ...def, art: cd.miniArtFor(def.name) } : def)
const formProps = (form: Form): Props => ({ hero: form === 'hero', mini: form === 'mini' })
const byName = Object.fromEntries(cd.CRITTERS.map(d => [d.name, d])) as Record<string, Def>
const FORMS: Form[] = ['hero', 'art', 'mini']
// One painted def per critter × form, shared by every section below (the
// cache is keyed by the def OBJECT — exactly what the mounts hand the painter).
const painted = new Map<string, Def>()
for (const def of cd.CRITTERS) for (const form of FORMS) painted.set(`${def.name}/${form}`, defFor(def, form))
const pd = (name: string, form: Form): Def => painted.get(`${name}/${form}`)!

t.section('§1 — root identity: the same inputs hand React the same element')
{
  for (const def of cd.CRITTERS) {
    for (const form of FORMS) {
      const d = pd(def.name, form)
      const frames: Props[] = [
        { ...formProps(form), swayPhase: 0 },
        { ...formProps(form), swayPhase: 3 },
        { ...formProps(form), swayPhase: 0, pupil: idle.EYE_SHUT },
        { ...formProps(form), swayPhase: 1, pupil: idle.EYE_SHUT, sleepPhase: 2 },
      ]
      let identical = true
      let distinct = true
      const roots: El[] = []
      for (const f of frames) {
        const a = paint({ def: d, ...f })
        const b = paint({ def: d, ...f })
        if (a !== b) identical = false
        roots.push(a)
      }
      // awake open vs lid: distinct roots (the frames differ)
      if (roots[0] === roots[2]) distinct = false
      t.check(`${def.name}/${form}: a repeated frame is the SAME root element (four frames)`, identical)
      t.check(`${def.name}/${form}: different frames are different roots`, distinct)
    }
  }
}

t.section('§2 — line reuse: only the cells that move are rebuilt')
{
  // The flowing hero: a sway step keeps every line above the flow depth.
  const jelly = pd('jellyfish', 'hero')
  const rest = paint({ def: jelly, hero: true, swayPhase: 0 })
  const step = paint({ def: jelly, hero: true, swayPhase: 2 })
  const restLines = linesOf(rest)
  const stepLines = linesOf(step)
  const flowLines = Math.ceil(cd.flowDepthFor(jelly, 'hero') / 2)
  const anchored = restLines.length - flowLines
  const keptAbove = restLines.slice(0, anchored).every((l, i) => l === stepLines[i])
  const movedBelow = restLines.slice(anchored).some((l, i) => l !== stepLines[anchored + i])
  t.check(`jellyfish/hero: a sway step keeps the ${anchored} anchored lines' element identity`, restLines.length === stepLines.length && keptAbove, `${restLines.length} lines`)
  t.check('jellyfish/hero: …and rebuilds a moving line (the strands actually move)', movedBelow)
  t.check('jellyfish/hero: a sway step is a different root (the frame differs)', rest !== step)
  // The blink: the eye line alone.
  const lid = paint({ def: jelly, hero: true, swayPhase: 0, pupil: idle.EYE_SHUT })
  const lidLines = linesOf(lid)
  const changed = restLines.map((l, i) => (l !== lidLines[i] ? i : -1)).filter(i => i >= 0)
  const eyeLine = Math.floor(jelly.heroArt!.findIndex(r => r.includes('K')) / 2)
  t.check(`jellyfish/hero: a blink rebuilds exactly the eye line (${eyeLine})`, changed.length === 1 && changed[0] === eyeLine, changed.join(','))
  // A still critter: every sway step is the SAME root.
  const crab = pd('crab', 'hero')
  const crabRoots = new Set<El>()
  for (let p = 0; p < cd.SWAY_PHASES; p++) crabRoots.add(paint({ def: crab, hero: true, swayPhase: p }))
  t.check('crab/hero: every sway phase returns the same root (nothing moves)', crabRoots.size === 1, String(crabRoots.size))
  // The settle: exactly two roots across the cycle (rest and settled).
  const clam = pd('clam', 'hero')
  const clamRoots = new Set<El>()
  for (let p = 0; p < cd.SWAY_PHASES; p++) clamRoots.add(paint({ def: clam, hero: true, swayPhase: p }))
  t.check('clam/hero: the sway cycle alternates between exactly two roots (rest · settled)', clamRoots.size === 2, String(clamRoots.size))
  const clamRest = paint({ def: clam, hero: true, swayPhase: 0 })
  const clamSettled = paint({ def: clam, hero: true, swayPhase: 2 })
  const settleLines = Math.ceil((cd.settleDepthFor(clam, 'hero') + 1) / 2)
  const clamKept = linesOf(clamRest).slice(settleLines).every((l, i) => l === linesOf(clamSettled)[settleLines + i])
  t.check(`clam/hero: the settle keeps every line below the valve (${settleLines} lines rebuilt)`, clamKept)
}

t.section('§3 — byte-identity: a hit renders what a miss renders, and what a cache-less render renders')
{
  const matrix: Array<{ name: string; form: Form; props: Props }> = []
  for (const def of cd.CRITTERS) {
    for (const form of FORMS) {
      for (let sway = 0; sway < cd.SWAY_PHASES; sway += 2) {
        matrix.push({ name: def.name, form, props: { ...formProps(form), swayPhase: sway } })
        matrix.push({ name: def.name, form, props: { ...formProps(form), swayPhase: sway, pupil: idle.EYE_SHUT } })
        for (let z = 0; z < cd.SLEEP_PHASES; z++) matrix.push({ name: def.name, form, props: { ...formProps(form), swayPhase: sway, pupil: idle.EYE_SHUT, sleepPhase: z } })
      }
      if (form === 'hero') {
        const key = gz.gazeKeyForPointer(def.heroArt!, -40, def.heroArt!.length / 2)
        matrix.push({ name: def.name, form, props: { hero: true, swayPhase: 0, gazeKey: key } })
        matrix.push({ name: def.name, form, props: { hero: true, wide: true, swayPhase: 4 } })
        matrix.push({ name: def.name, form, props: { hero: true, swayPhase: 0, glowToward: '#7fd8c8' } })
        matrix.push({ name: def.name, form, props: { hero: true, swayPhase: 0, lineBg: (i: number) => (i % 2 ? '#221f1a' : '#1b1916') } })
      }
      if (form === 'art') matrix.push({ name: def.name, form, props: { chunky: true, swayPhase: 0, pupil: idle.EYE_SHUT, sleepPhase: 2 } })
    }
  }
  // The first mount in a process warms the layout engine; the matrix starts
  // on a warm renderer so every frame is measured under the same conditions.
  await renderToString(React.createElement(CritterArt, { def: pd('crab', 'hero'), hero: true } as never), 60)
  let same = 0
  let total = 0
  const bad: string[] = []
  const transients: string[] = []
  for (const m of matrix) {
    const shared = pd(m.name, m.form)
    const cold: Def = { ...shared } // a fresh object: no cache entry, every line a miss
    const el = (d: Def): React.ReactElement => React.createElement(CritterArt, { def: d, ...m.props } as never)
    const missPlain = await renderToString(el(shared), 60)
    const missAnsi = await renderToAnsiString(el(shared), 60)
    const hitPlain = await renderToString(el(shared), 60)
    const hitAnsi = await renderToAnsiString(el(shared), 60)
    const coldPlain = await renderToString(el(cold), 60)
    const coldAnsi = await renderToAnsiString(el(cold), 60)
    total++
    let identical = missPlain === hitPlain && missAnsi === hitAnsi && coldPlain === hitPlain && coldAnsi === hitAnsi && missPlain.trim() !== ''
    if (!identical) {
      // A TRANSIENT, not a cache defect: the capture reads one sync window,
      // and a miss can land two commits of the same frame inside it (the
      // built tree, then the committed root) — the string reads as two
      // frames (pool run 5: crab/mini/sleep 1, 69 vs 35 chars, once in
      // four runs). Re-render the pair once: a settled match is a NAMED
      // transient, never a red; a persistent mismatch is the cache's own.
      const againPlain = await renderToString(el(shared), 60)
      const againAnsi = await renderToAnsiString(el(shared), 60)
      const cold2: Def = { ...shared }
      const cold2Plain = await renderToString(el(cold2), 60)
      const cold2Ansi = await renderToAnsiString(el(cold2), 60)
      if (againPlain === hitPlain && againAnsi === hitAnsi && cold2Plain === hitPlain && cold2Ansi === hitAnsi && hitPlain.trim() !== '') {
        transients.push(`${m.name}/${m.form}/${JSON.stringify(m.props)} (lens ${missPlain.length}/${hitPlain.length}/${coldPlain.length})`)
        identical = true
      }
    }
    if (identical) same++
    else bad.push(`${m.name}/${m.form}/${JSON.stringify(m.props)} [miss=hit plain:${missPlain === hitPlain} ansi:${missAnsi === hitAnsi} · cold=hit plain:${coldPlain === hitPlain} ansi:${coldAnsi === hitAnsi} · lens ${missPlain.length}/${hitPlain.length}/${coldPlain.length}]`)
  }
  if (transients.length > 0) console.log(`  note: ${transients.length} transient double frame(s) settled on a re-render — ${transients.slice(0, 3).join(' · ')}`)
  t.check(`every frame of the matrix renders BYTE-IDENTICAL through a hit, a miss and a cache-less def (${same}/${total}, plain + truecolour ANSI, none empty)`, same === total && total >= 200, bad.slice(0, 6).join(' · '))
  t.check('transient double frames are rare (at most 2 of the matrix) — a miss may land two commits in one sync window', transients.length <= 2, transients.join(' · '))
  t.check('the ANSI legs carry colour (the comparison covers fg/bg bytes)', (await renderToAnsiString(React.createElement(CritterArt, { def: pd('crab', 'hero'), hero: true } as never), 60)).includes('\x1b[38;2;'))
}

t.section('§4 — bounds: a whole cycle stays under the caps; contexts cold-start past theirs')
{
  for (const def of cd.CRITTERS) {
    for (const form of FORMS) {
      // A FRESH def object: its own cache, so the count is this cycle's alone.
      const d: Def = { ...defFor(def, form) }
      // The AWAKE cycle (every sway phase, open and lidded) paints in ONE
      // context: the sliced width never moves while awake.
      for (let p = 0; p < cd.SWAY_PHASES; p++) {
        for (const pupil of [idle.EYE_OPEN, idle.EYE_SHUT]) paint({ def: d, ...formProps(form), swayPhase: p, pupil })
      }
      const awake = critterFrameCacheStatsForProofs(d)
      t.check(`${def.name}/${form}: the awake cycle paints in ONE context (${awake.lines} lines · ${awake.roots} roots)`, awake.contexts === 1 && awake.lines > 0)
      // The SLEEP cycle on top: a hero pose slices to its own width (and a
      // flowing pose whose coil reaches the slice edge widens it on a phase),
      // each width a paint context of its own — bounded by the context cap.
      for (let p = 0; p < cd.SWAY_PHASES; p++) {
        for (let z = 0; z < cd.SLEEP_PHASES; z++) paint({ def: d, ...formProps(form), swayPhase: p, pupil: idle.EYE_SHUT, sleepPhase: z })
      }
      const s = critterFrameCacheStatsForProofs(d)
      t.check(`${def.name}/${form}: the full sway × blink × sleep cycle stays under the caps (${s.lines} lines ≤ 96 · ${s.roots} roots ≤ 48 · ${s.contexts} contexts ≤ 4)`, s.lines <= 96 && s.roots <= 48 && s.contexts <= 4 && s.lines > 0)
    }
  }
  // Contexts: the same def painted under five paint contexts restarts at the cap of four.
  const d: Def = { ...byName['octopus']! }
  const contexts: Props[] = [{}, { chunky: true }, { glowToward: '#7fd8c8' }, { legendOverride: { C: '#3fbfa0' } }, { pupil: '◦' }]
  for (const c of contexts) paint({ def: d, ...c })
  const s = critterFrameCacheStatsForProofs(d)
  t.check(`five paint contexts on one def restart at the cap (contexts held: ${s.contexts} ≤ 4)`, s.contexts <= 4 && s.contexts >= 1)
}

t.section('§5 — the effective sway phase: what the transforms read, and nothing else')
{
  const H = cd.SWAY_PHASES
  for (const def of cd.CRITTERS) {
    for (const form of FORMS) {
      const d = pd(def.name, form)
      for (const asleep of [false, true]) {
        let sameBytes = true
        const seen = new Set<number>()
        for (let p = 0; p < H; p++) {
          const eff = cd.effectiveSwayPhase(d, form, asleep, p)
          seen.add(eff)
          const props = asleep
            ? { ...formProps(form), pupil: idle.EYE_SHUT, sleepPhase: 1 }
            : { ...formProps(form) }
          const raw = await renderToString(React.createElement(CritterArt, { def: d, ...props, swayPhase: p } as never), 60)
          const folded = await renderToString(React.createElement(CritterArt, { def: d, ...props, swayPhase: eff } as never), 60)
          if (raw !== folded) sameBytes = false
        }
        t.check(`${def.name}/${form}/${asleep ? 'asleep' : 'awake'}: the painter's bytes at every raw phase equal its bytes at the effective phase`, sameBytes)
        const flow = asleep ? (cd.sleepPoseFor(d, form)?.flow ?? cd.flowDepthFor(d, form)) : cd.flowDepthFor(d, form)
        const settle = asleep ? 0 : cd.settleDepthFor(d, form)
        if (flow > 0) t.check(`${def.name}/${form}/${asleep ? 'asleep' : 'awake'}: a flowing form keeps every phase (${seen.size} of ${H})`, seen.size === H)
        else if (asleep && cd.sleepPoseFor(d, form)) t.check(`${def.name}/${form}/asleep: a still pose keeps the breath's parity alone (${[...seen].sort().join(',')})`, seen.size === 2 && seen.has(0) && seen.has(1))
        else if (settle > 0) t.check(`${def.name}/${form}/awake: a settling form folds to rest and the settle phase (${[...seen].sort().join(',')})`, seen.size === 2 && seen.has(0))
        else t.check(`${def.name}/${form}/${asleep ? 'asleep' : 'awake'}: a still form folds every phase to 0`, seen.size === 1 && seen.has(0))
      }
    }
  }
  t.check('a negative or out-of-range phase folds like its modulo (total)', cd.effectiveSwayPhase(byName['jellyfish']!, 'hero', false, -1) === H - 1 && cd.effectiveSwayPhase(byName['jellyfish']!, 'hero', false, H + 2) === 2)
}

t.section('§6 — the gaze memos: same object for the same grid, same values as a fresh scan')
{
  for (const def of cd.CRITTERS) {
    const art = def.heroArt!
    const a = gz.heroEyeClusters(art)
    const b = gz.heroEyeClusters(art)
    const fresh = gz.heroEyeClusters([...art])
    t.check(`${def.name}: heroEyeClusters answers the same object for the same grid`, a === b && a.length >= 2)
    t.check(`${def.name}: …with the same values as a fresh scan of a copy`, JSON.stringify(a) === JSON.stringify(fresh))
    const ba = cd.heroContentBounds(art)
    const bb = cd.heroContentBounds(art)
    const bf = cd.heroContentBounds([...art])
    t.check(`${def.name}: heroContentBounds answers the same tuple for the same grid, the same values for a copy`, ba === bb && ba[0] === bf[0] && ba[1] === bf[1])
  }
  // A transformed grid is its own key: a moved pupil discovers its own clusters.
  const crab = byName['crab']!.heroArt!
  const moved = gz.applyGazeKey(crab, gz.gazeKeyForPointer(crab, -40, crab.length / 2))
  t.check('a gazed grid (a new array) discovers its own clusters — the rest cells differ from the authored grid\'s', moved !== crab && JSON.stringify(gz.heroEyeClusters(moved).map(c => c.rest)) !== JSON.stringify(gz.heroEyeClusters(crab).map(c => c.rest)))
}

t.section('§8 — under the REAL clock a still critter never commits a frame identical to its previous one')
{
  // The animated mount under ink with the product's clock (the shared
  // interval, keep-alive subscribers): every commit writes a full frame to
  // the non-TTY stream. A still critter's only edges are its blinks, and a
  // settling one's only edges are the valve's drops and lifts — so no two
  // consecutive committed frames may be byte-identical. (The clock's sway
  // digit steps three times in the window; each step is a commit that
  // paints the same cells unless the mount folds it.)
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { renderSync } = await import('../../src/ink/root.js')
  const { AnimatedCritterArt } = await import('../../src/components/mercury-ui/AnimatedCritterArt.js')
  const sleep = await import('../../src/utils/cockpit/critterSleep.js')
  const stripAnsi = (await import('strip-ansi')).default
  const stdinStub = (): NodeJS.ReadStream =>
    Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode() { return this },
      setEncoding() { return this },
      read() { return null },
      unref() { return this },
      ref() { return this },
      pause() { return this },
      resume() { return this },
    }) as unknown as NodeJS.ReadStream
  delete process.env['MERCURY_CRITTER_IDLE']
  delete process.env['MERCURY_CRITTER_SLEEP']
  // A BLINK-FREE window: the lid rides the epoch clock (pupilForTime over
  // Date.now(), the lid at the top of every BLINK_CYCLE and a second lid at
  // SECOND_LID_AT on every fourth), so the window is opened only once the
  // cycle has passed both lids and has room for the whole drive.
  const WINDOW_MS = idle.SWAY_TICK_MS * 3 + 400
  const safeStart = idle.SECOND_LID_AT + idle.LID_MS + 200
  const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const openWindow = async (): Promise<void> => {
    for (;;) {
      const at = Date.now() % idle.BLINK_CYCLE
      if (at >= safeStart && at + WINDOW_MS + 200 < idle.BLINK_CYCLE) return
      await wait(50)
    }
  }
  for (const [name, form, still] of [['crab', 'hero', true], ['crab', 'mini', true], ['clam', 'hero', false], ['clam', 'art', false]] as Array<[string, Form, boolean]>) {
    await openWindow()
    sleep.resetCritterSleepForTests()
    const d = pd(name, form)
    const stream = new PassThrough()
    const written: string[] = []
    stream.on('data', (chunk: Buffer | string) => { written.push(stripAnsi(chunk.toString())) })
    const target = stream as unknown as NodeJS.WriteStream & { columns?: number; rows?: number }
    target.columns = 60
    target.rows = 30
    const inst = renderSync(React.createElement(AnimatedCritterArt, { def: d, ...formProps(form) } as never), { stdout: target, stdin: stdinStub(), patchConsole: false, exitOnCtrlC: false })
    await wait(200)
    const first = written.length
    await wait(idle.SWAY_TICK_MS * 3 + 200)
    const last = written.length
    inst.unmount()
    const frames = written.slice(first, last)
    let identicalRuns = 0
    for (let i = 1; i < frames.length; i++) if (frames[i] === frames[i - 1]) identicalRuns++
    if (still) t.check(`${name}/${form}: a STILL critter commits ZERO frames across three sway ticks in a blink-free window (${frames.length})`, frames.length === 0)
    else t.check(`${name}/${form}: the settle commits only its drops and lifts across three sway ticks (${frames.length} ≤ 2, none identical to its predecessor)`, frames.length <= 2 && identicalRuns === 0, `${identicalRuns} identical consecutive frame(s)`)
  }
  sleep.resetCritterSleepForTests()
}

t.section('§7 — source locks')
{
  const animated = await Bun.file('src/components/mercury-ui/AnimatedCritterArt.tsx').text()
  t.check('the view feeds the painter the EFFECTIVE sway phase', /const swayPhase = effectiveSwayPhase\(def, /.test(animated))
  t.check('the committed frame value is the FOLDED key; the raw key rides a ref the derive writes', /rawKeyRef\.current = key/.test(animated) && /readCritterFrameKey\(rawKeyRef\.current \|\| frameKey\)/.test(animated))
  const painter = await Bun.file('src/components/mercury-ui/CritterArt.tsx').text()
  t.check('the painter keys its frame cache by the def object (the def-identity rule)', /new WeakMap<CritterDef, Map<string, FrameCache>>/.test(painter))
  t.check('the painter hands back a cached root before building lines', painter.indexOf('cache.roots.get(frameKey)') > 0 && painter.indexOf('cache.roots.get(frameKey)') < painter.indexOf('cache.lines.get(lineKey)'))
  t.check('the painter runs no hooks (callable as a pure function)', !/\buse[A-Z]\w*\(/.test(painter.slice(painter.indexOf('function CritterArtImpl'), painter.indexOf('export const CritterArt'))))
}

t.finish('CRITTER-FRAME-CACHE')
