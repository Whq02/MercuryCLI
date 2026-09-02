#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'critter-sleep-'))

const t = checker()
const cd = await import('../../src/utils/cockpit/critterData.js')
const idle = await import('../../src/utils/cockpit/critterIdle.js')
const sleep = await import('../../src/utils/cockpit/critterSleep.js')

const quiet = {
  turnLive: false,
  turnStartTs: null,
  streaming: false,
  awaitingPermission: false,
  lastTurnEndTs: null,
}

t.section('§1 — the sleep derivation (CR-3: agent activity + grace)')
{
  const T0 = 1_000_000_000
  const past = sleep.SLEEP_AFTER_MS
  const { BUDDY_FRESH_MS } = await import('../../src/utils/cockpit/buddyState.js')
  t.check(
    'the grace IS the roster fresh-vs-stale contract (one definition of recent)',
    sleep.SLEEP_AFTER_MS === BUDDY_FRESH_MS,
    String(sleep.SLEEP_AFTER_MS),
  )
  t.check('a live turn is active', sleep.signalsActive({ ...quiet, turnLive: true }))
  t.check('streaming tokens are active', sleep.signalsActive({ ...quiet, streaming: true }))
  t.check('a pending permission ask is active', sleep.signalsActive({ ...quiet, awaitingPermission: true }))
  t.check('published quiet is NOT active', !sleep.signalsActive(quiet))

  const agentsLive = { liveNow: true, lastEventTs: 0 }
  const agentsQuiet = (ts: number) => ({ liveNow: false, lastEventTs: ts })
  t.check(
    'a live agent keeps it awake however long the session itself was quiet',
    !sleep.isAsleepAt(quiet, T0, T0 + past * 100, agentsLive),
    'awake',
  )
  t.check(
    'the grace counts from the last agent EVENT (a stop is activity at that instant)',
    !sleep.isAsleepAt(quiet, T0, T0 + past * 10, agentsQuiet(T0 + past * 10 - 1_000)) &&
      sleep.isAsleepAt(quiet, T0, T0 + past * 10, agentsQuiet(T0 + past * 9)),
    'delays, then sleeps',
  )
  t.check(
    'no agent facts at all degrade to the session-only derivation',
    sleep.isAsleepAt(quiet, T0, T0 + past) &&
      sleep.lastActivityTs(quiet, T0, T0 + 5) === sleep.lastActivityTs(quiet, T0, T0 + 5, { liveNow: false, lastEventTs: 0 }),
    'default agents = none',
  )

  t.check(
    'a fresh session is awake at t=0',
    !sleep.isAsleepAt(quiet, T0, T0),
    'awake',
  )
  t.check(
    'a fresh session that just sits there DOES fall asleep at the threshold',
    sleep.isAsleepAt(quiet, T0, T0 + past),
    'asleep',
  )
  t.check(
    'one second short of the threshold it is still awake',
    !sleep.isAsleepAt(quiet, T0, T0 + past - 1_000),
    'awake',
  )
  t.check(
    'a live turn wakes it however long it slept',
    !sleep.isAsleepAt({ ...quiet, turnLive: true }, T0, T0 + past * 10),
    'awake',
  )
  t.check(
    'a permission ask wakes it (blocked-on-you is not idle)',
    !sleep.isAsleepAt({ ...quiet, awaitingPermission: true }, T0, T0 + past * 10),
    'awake',
  )
  t.check(
    'quiet is measured from the last turn END, not the baseline',
    !sleep.isAsleepAt({ ...quiet, lastTurnEndTs: T0 + past }, T0, T0 + past + 1_000),
    'awake',
  )
  t.check(
    'lastActivityTs never reads before the session baseline',
    sleep.lastActivityTs(quiet, T0, T0 + 5) === T0,
    String(sleep.lastActivityTs(quiet, T0, T0 + 5)),
  )
}

t.section('§2 — store discipline: no subscriber, no work')
{
  const before = sleep.critterSleepStatsForProofs()
  t.check('idle module holds no subscriptions before any mount', before.listeners === 0 && !before.signalsArmed && !before.execArmed && !before.clockArmed, JSON.stringify(before))
  const off = sleep.subscribeCritterSleep(() => {})
  const armed = sleep.critterSleepStatsForProofs()
  t.check('the FIRST subscriber arms the signal push', armed.listeners === 1 && armed.signalsArmed, JSON.stringify(armed))
  t.check(
    'the FIRST subscriber arms the execution-plane push (the agent wake edge)',
    armed.execArmed,
    JSON.stringify(armed),
  )
  t.check(
    'awake ⇒ the elapse clock is armed; asleep would drop it',
    armed.asleep ? !armed.clockArmed : armed.clockArmed,
    JSON.stringify(armed),
  )
  off()
  const after = sleep.critterSleepStatsForProofs()
  t.check(
    'the LAST unsubscribe tears down every subscription and the timer',
    after.listeners === 0 && !after.signalsArmed && !after.execArmed && !after.clockArmed,
    JSON.stringify(after),
  )
}

t.section('§3 — swayRows: the extremities move, the mass does not')
{
  const grids: [string, string[], number][] = [
    ['crab', cd.CRITTERS[0]!.art, cd.flowDepthFor(cd.CRITTERS[0]!, 'art')],
    ['octopus', cd.CRITTERS[1]!.art, cd.flowDepthFor(cd.CRITTERS[1]!, 'art')],
    ['jellyfish', cd.CRITTERS[2]!.art, cd.flowDepthFor(cd.CRITTERS[2]!, 'art')],
    ['clam', cd.CRITTERS[3]!.art, cd.flowDepthFor(cd.CRITTERS[3]!, 'art')],
  ]
  const ink = (rows: string[]): number => rows.join('').replace(/\./g, '').length
  for (const [name, art, depth] of grids) {
    for (let p = 0; p < cd.SWAY_PHASES; p++) {
      const out = cd.swayRows(art, depth, p)
      t.check(`${name} p${p}: row count + every width preserved`, out.length === art.length && out.every((r, i) => r.length === art[i]!.length))
      t.check(`${name} p${p}: no painted cell is ever lost`, ink(out) === ink(art), `${ink(out)} vs ${ink(art)}`)
      const firstMoving = Math.max(0, art.length - depth)
      t.check(
        `${name} p${p}: rows above the flow depth are byte-identical`,
        out.slice(0, firstMoving).every((r, i) => r === art[i]),
        `anchored 0..${firstMoving - 1}`,
      )
    }
  }
  const jelly = cd.CRITTERS[2]!
  const depth = cd.flowDepthFor(jelly, 'art')
  const frames = new Set<string>()
  for (let p = 0; p < cd.SWAY_PHASES; p++) frames.add(cd.swayRows(jelly.art, depth, p).join('\n'))
  t.check('the jellyfish authors more than one distinct tentacle frame', frames.size > 1, String(frames.size))
  t.check('the jellyfish root row (7) is above the flow depth', jelly.art.length - depth === 8, String(jelly.art.length - depth))
  t.check('the crab authors no flow (planted by design)', cd.flowDepthFor(cd.CRITTERS[0]!, 'art') === 0)
  t.check('depth 0 is the authored grid, byte for byte', cd.swayRows(cd.CRITTERS[0]!.art, 0, 3).join('\n') === cd.CRITTERS[0]!.art.join('\n'))
}

t.section('§4 — the Zzz never touches the creature')
{
  const forms: [string, string[]][] = []
  for (const def of cd.CRITTERS) {
    forms.push([`${def.name} flat`, def.art])
    forms.push([`${def.name} hero`, def.heroArt!])
    forms.push([`${def.name} mini`, cd.miniArtFor(def.name)])
  }
  for (const [label, art] of forms) {
    const slots = cd.sleepZzzSlots(art)
    t.check(`${label}: a Zzz slot exists`, slots.length > 0, JSON.stringify(slots))
    t.check(
      `${label}: every slot is empty in both rows of the top pair`,
      slots.every(c => (art[0]![c] ?? '.') === '.' && (art[1]![c] ?? '.') === '.'),
      JSON.stringify(slots),
    )
    for (let p = 0; p < cd.SLEEP_PHASES; p++) {
      const out = cd.sleepZzzArt(art, p)
      t.check(`${label} z${p}: geometry preserved`, out.length === art.length && out.every((r, i) => r.length === art[i]!.length))
      const damaged: string[] = []
      out.forEach((row, i) => {
        for (let c = 0; c < row.length; c++) {
          const before = art[i]![c]
          const now = row[c]
          if (now !== before && !(before === '.' && now === cd.SLEEP_CELL)) damaged.push(`${i}:${c} ${before}->${now}`)
        }
      })
      t.check(`${label} z${p}: only empty cells become z`, damaged.length === 0, damaged.join(','))
      t.check(`${label} z${p}: nothing below the top pair changes`, out.slice(2).every((r, i) => r === art[i + 2]), 'below')
    }
  }
  const distinct = new Set<string>()
  for (let p = 0; p < cd.SLEEP_PHASES; p++) distinct.add(cd.sleepZzzArt(cd.CRITTERS[0]!.art, p).join('\n'))
  t.check('the Zzz cycles through distinct frames', distinct.size > 1, String(distinct.size))
  const full = ['MMM', 'MMM', 'MMM']
  t.check('a full top pair yields no slots and no damage', cd.sleepZzzSlots(full).length === 0 && cd.sleepZzzArt(full, 2).join('') === full.join(''))
}

t.section('§5 — the packed frame key')
{
  const awake = idle.critterFrameKey(0, false)
  const asleep = idle.critterFrameKey(0, true)
  t.check('awake and asleep keys differ', awake !== asleep, `${awake} / ${asleep}`)
  t.check('every key is three characters', awake.length === 3 && asleep.length === 3, `${awake} / ${asleep}`)
  t.check('an awake key carries NO sleep phase', idle.readCritterFrameKey(awake).sleepPhase === null, awake)
  t.check('an asleep key carries a sleep phase', idle.readCritterFrameKey(asleep).sleepPhase !== null, asleep)
  t.check('an asleep key is always lidded', idle.readCritterFrameKey(asleep).pupil === idle.EYE_SHUT, asleep)
  const swaySeen = new Set<number>()
  const zSeen = new Set<number>()
  let bad = ''
  for (let ms = 0; ms < 60_000; ms += 100) {
    for (const isAsleep of [false, true]) {
      const k = idle.critterFrameKey(ms, isAsleep)
      const r = idle.readCritterFrameKey(k)
      if (!(r.swayPhase >= 0 && r.swayPhase < cd.SWAY_PHASES)) bad = `sway ${r.swayPhase} @${ms}`
      if (r.sleepPhase !== null && !(r.sleepPhase >= 0 && r.sleepPhase < cd.SLEEP_PHASES)) bad = `zzz ${r.sleepPhase} @${ms}`
      if (isAsleep) {
        swaySeen.add(r.swayPhase)
        if (r.sleepPhase !== null) zSeen.add(r.sleepPhase)
      }
    }
  }
  t.check('every unpacked phase stays in range over a minute of clock', bad === '', bad)
  t.check('the sleeping sway visits every phase', swaySeen.size === cd.SWAY_PHASES, String(swaySeen.size))
  t.check('the Zzz visits every phase', zSeen.size === cd.SLEEP_PHASES, String(zSeen.size))
  t.check('the sleeping drift is slower than the waking one', idle.SLEEP_SWAY_TICK_MS > idle.SWAY_TICK_MS, `${idle.SLEEP_SWAY_TICK_MS} > ${idle.SWAY_TICK_MS}`)
  t.check('a malformed key degrades to the rest frame rather than throwing', idle.readCritterFrameKey('').swayPhase === 0)
}

t.section('§5b — sway continuity across the sleep boundary (CR-2)')
{
  let identical = true
  for (let ms = 0; ms < 30_000; ms += 37) {
    if (idle.swayPhaseAt(ms, false) !== Math.floor(ms / idle.SWAY_TICK_MS) % cd.SWAY_PHASES) identical = false
    if (idle.swayPhaseAt(ms, true) !== Math.floor(ms / idle.SLEEP_SWAY_TICK_MS) % cd.SWAY_PHASES) identical = false
  }
  t.check('the default anchor IS the historical schedule (both cadences)', identical)

  const flips = [4_100, 11_300, 23_900]
  let anchor = { phase: 0, at: 0 }
  let asleepNow = false
  let prevPhase = idle.swayPhaseAt(0, asleepNow, anchor)
  let smooth = true
  let flipContinuous = true
  for (let ms = 0; ms <= 30_000; ms += 20) {
    if (flips.includes(ms)) {
      const showing = idle.swayPhaseAt(ms, asleepNow, anchor)
      anchor = { phase: showing, at: ms }
      asleepNow = !asleepNow
      if (idle.swayPhaseAt(ms, asleepNow, anchor) !== showing) flipContinuous = false
    }
    const phase = idle.swayPhaseAt(ms, asleepNow, anchor)
    const step = (phase - prevPhase + cd.SWAY_PHASES) % cd.SWAY_PHASES
    if (step > 1) smooth = false
    prevPhase = phase
  }
  t.check('the phase at a flip instant is the phase the old regime was showing', flipContinuous)
  t.check('the phase never teleports — every step is 0 or +1', smooth)

  const since = 987_654
  const ladder = [0, 1, 2, 0, 1, 2].every(
    (want, k) =>
      idle
        .readCritterFrameKey(
          idle.critterFrameKey(since + k * idle.SLEEP_TICK_MS, true, idle.ZERO_SWAY_ANCHOR, since),
        )
        .sleepPhase === want,
  )
  t.check('the Zzz climbs z → zz → zzz from the onset and loops forever', ladder)

  sleep.resetCritterSleepForTests()
  const anchorBefore = sleep.critterSwayAnchor()
  process.env['MERCURY_CRITTER_SLEEP'] = '1'
  const off = sleep.subscribeCritterSleep(() => {})
  const flipped = sleep.critterSleepStatsForProofs().asleep
  const anchorAfter = sleep.critterSwayAnchor()
  t.check(
    'a verdict flip re-stamps the sway anchor',
    flipped && (anchorAfter.at > anchorBefore.at || anchorAfter !== anchorBefore),
    JSON.stringify({ flipped, before: anchorBefore.at, after: anchorAfter.at }),
  )
  off()
  delete process.env['MERCURY_CRITTER_SLEEP']
  sleep.resetCritterSleepForTests()
}

t.section('§6 — the wiring laws')
{
  const animated = await Bun.file('src/components/mercury-ui/AnimatedCritterArt.tsx').text()
  t.check(
    'ONE clock subscription carries pupil + sway + Zzz (one viewport ref can own the box)',
    (animated.match(/useIdleAnimation\(/g) ?? []).length === 2 && /readCritterFrameKey/.test(animated),
    'one packed key for the art, one for the breathing dot',
  )
  t.check(
    'the frame derive is the store-owned critterLiveFrameKey (one time base)',
    /critterLiveFrameKey\(\)/.test(animated) && !/critterFrameKey\(/.test(animated),
    'store-owned derive',
  )
  t.check(
    'the sleep verdict is a STORE read, never a poller in the view',
    /subscribeCritterSleep/.test(animated) && !/setInterval|setTimeout/.test(animated),
    'store read',
  )
  t.check('the gaze is disarmed while asleep', /!asleep/.test(animated), 'gaze gate')
  t.check(
    'specimen mounts veto the LIVE verdict but never the forced capture gate',
    /!specimen \|\| critterSleepMode\(\) === 'forced'/.test(animated),
    'specimen seam',
  )

  const painter = await Bun.file('src/components/mercury-ui/CritterArt.tsx').text()
  const sliceAt = painter.indexOf('heroContentBounds(rows)')
  const zzzAt = painter.indexOf('sleepZzzArt(')
  t.check(
    'the Zzz is applied AFTER the hero content slice (the width contract)',
    sliceAt > 0 && zzzAt > sliceAt,
    `slice@${sliceAt} zzz@${zzzAt}`,
  )
  t.check(
    'the sway is applied BEFORE the slice (a bounded shift of authored pixels)',
    painter.indexOf('swayRows(') > 0 && painter.indexOf('swayRows(') < sliceAt,
    'sway before slice',
  )
  const poseAt = painter.indexOf('sleepPoseFor(')
  const breathAt = painter.indexOf('sleepBreathArt(')
  t.check(
    'the sleep pose is resolved BEFORE the transform chain and the breath sits before the sway',
    poseAt > 0 && poseAt < painter.indexOf('applyGazeKey(') && breathAt > 0 && breathAt < painter.indexOf('swayRows('),
    `pose@${poseAt} breath@${breathAt}`,
  )

  for (const [file, label] of [
    ['src/components/mercury-ui/MiniCritter.tsx', 'the mini companion'],
    ['src/components/CritterSelect.tsx', 'the /critter picker'],
    ['src/components/MercuryHome.tsx', 'the hero + the berth'],
  ] as const) {
    const src = await Bun.file(file).text()
    t.check(`${label} mounts AnimatedCritterArt`, /AnimatedCritterArt/.test(src) && !/<CritterArt\b/.test(src), file)
  }
}

t.section('§7 — the authored sleep poses (CR-3)')
{
  const specks = (art: string[]): string[] => {
    const found: string[] = []
    for (let r = 0; r < art.length; r++) {
      for (let c = 0; c < art[r]!.length; c++) {
        if (art[r]![c] === '.') continue
        let touched = false
        for (let dr = -1; dr <= 1 && !touched; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue
            if ((art[r + dr]?.[c + dc] ?? '.') !== '.') {
              touched = true
              break
            }
          }
        }
        if (!touched) found.push(`${r}:${c}`)
      }
    }
    return found
  }
  for (const def of cd.CRITTERS) {
    const forms: Array<['art' | 'hero' | 'mini', string[]]> = [
      ['art', def.art],
      ['hero', def.heroArt!],
      ['mini', cd.miniArtFor(def.name)],
    ]
    for (const [form, awake] of forms) {
      const pose = cd.sleepPoseFor(def, form)
      t.check(`${def.name}/${form}: an authored sleep pose exists`, pose !== null)
      if (!pose) continue
      const art = pose.art
      t.check(
        `${def.name}/${form} pose: same row count + uniform awake width (the mount's slot holds)`,
        art.length === awake.length && art.every(r => r.length === awake[0]!.length),
      )
      const chars = new Set(art.join('').split('').filter(c => c !== '.'))
      t.check(
        `${def.name}/${form} pose: every char maps in cellColor`,
        [...chars].every(c => /^#[0-9a-f]{6}$/i.test(cd.cellColor(def, c) ?? '')),
        [...chars].join(''),
      )
      const [aS, aE] = cd.heroContentBounds(awake)
      const [pS, pE] = cd.heroContentBounds(art)
      t.check(`${def.name}/${form} pose: bounds inside the awake grid's`, pS >= aS && pE <= aE, `[${pS},${pE}) vs [${aS},${aE})`)
      t.check(`${def.name}/${form} pose: three Zzz slots (the full ladder)`, cd.sleepZzzSlots(art).length >= 3, String(cd.sleepZzzSlots(art).length))
      t.check(`${def.name}/${form} pose: no detached fragments`, specks(art).length === 0, specks(art).join(' '))
      const b1 = cd.sleepBreathArt(art, 1)
      t.check(`${def.name}/${form} breath: frame 0 is the pose byte-for-byte`, cd.sleepBreathArt(art, 0).join('\n') === art.join('\n'))
      t.check(`${def.name}/${form} breath: the exhale frame differs (the dip is visible)`, b1.join('\n') !== art.join('\n'))
      let onlyClears = true
      for (let r = 0; r < b1.length; r++) {
        for (let c = 0; c < b1[r]!.length; c++) {
          if (b1[r]![c] !== art[r]![c] && b1[r]![c] !== '.') onlyClears = false
        }
      }
      const [bS, bE] = cd.heroContentBounds(b1)
      t.check(`${def.name}/${form} breath: only clears cells, bounds pinned`, onlyClears && bS === pS && bE === pE)
      t.check(`${def.name}/${form} breath: no fragments on the exhale`, specks(b1).length === 0, specks(b1).join(' '))
      t.check(`${def.name}/${form} pose flow: whole pairs`, pose.flow % 2 === 0 && (art.length - pose.flow) % 2 === 0, String(pose.flow))
      if (pose.flow > 0) {
        const frames = new Set<string>()
        for (let p = 0; p < cd.SWAY_PHASES; p++) frames.add(cd.swayRows(art, pose.flow, p).join('\n'))
        t.check(`${def.name}/${form} pose flow: the drift actually moves`, frames.size > 1, String(frames.size))
      }
    }
  }
  for (const def of cd.CRITTERS) {
    for (const [form, art] of [['art', def.art], ['hero', def.heroArt!], ['mini', cd.miniArtFor(def.name)]] as const) {
      const depth = cd.flowDepthFor(def, form)
      if (depth <= 0) continue
      const frames = new Set<string>()
      for (let p = 0; p < cd.SWAY_PHASES; p++) frames.add(cd.swayRows(art, depth, p).join('\n'))
      t.check(`${def.name}/${form} awake flow: moves (no edge-pinned no-op)`, frames.size > 1, String(frames.size))
      t.check(`${def.name}/${form} awake flow: whole pairs`, depth % 2 === 0 && (art.length - depth) % 2 === 0, String(depth))
    }
  }
}

t.section('§8 — LIVENESS: nothing ever freezes (the CR-3 mandate)')
{
  const somePhases = (keys: string[], pick: (k: string) => unknown): number =>
    new Set(keys.map(pick).map(String)).size

  sleep.resetCritterSleepForTests()
  process.env['MERCURY_CRITTER_SLEEP'] = '1'
  const offForced = sleep.subscribeCritterSleep(() => {})
  t.check('forced gate: the store verdict is asleep', sleep.isCritterAsleep())
  {
    const t0 = Date.now()
    let frozenWindow = ''
    const seen = new Set<number>()
    let prev: string[] = []
    for (let step = 0; step < (6 * 60 * 60 * 1000) / idle.SLEEP_TICK_MS; step++) {
      const key = sleep.critterLiveFrameKey(t0 + step * idle.SLEEP_TICK_MS)
      const ph = idle.readCritterFrameKey(key).sleepPhase
      if (ph !== null) seen.add(ph)
      prev.push(key)
      if (prev.length > 3) prev.shift()
      if (prev.length === 3 && new Set(prev).size < 2) frozenWindow = `@step ${step}: ${prev.join(',')}`
    }
    t.check('asleep: the z visits every phase over simulated hours', seen.size === cd.SLEEP_PHASES, String(seen.size))
    t.check('asleep: no three consecutive samples are ever identical (the freeze class)', frozenWindow === '', frozenWindow)
  }
  offForced()
  delete process.env['MERCURY_CRITTER_SLEEP']
  sleep.resetCritterSleepForTests()

  {
    const offLive = sleep.subscribeCritterSleep(() => {})
    t.check('live gate: a fresh session is awake', !sleep.isCritterAsleep())
    const t0 = Date.now()
    const keys: string[] = []
    for (let ms = 0; ms <= idle.BLINK_CYCLE * 2; ms += idle.IDLE_TICK_MS) {
      keys.push(sleep.critterLiveFrameKey(t0 + ms))
    }
    t.check('awake: the sway phase advances', somePhases(keys, k => idle.readCritterFrameKey(k).swayPhase) > 1)
    t.check('awake: the blink fires (the pupil takes both glyphs)', somePhases(keys, k => idle.readCritterFrameKey(k).pupil) > 1)
    offLive()
  }

  {
    sleep.resetCritterSleepForTests()
    process.env['MERCURY_CRITTER_SLEEP'] = '1'
    const off1 = sleep.subscribeCritterSleep(() => {})
    const sleptAnchor = sleep.critterSwayAnchor()
    off1()
    delete process.env['MERCURY_CRITTER_SLEEP']
    const off2 = sleep.subscribeCritterSleep(() => {})
    t.check('the wake flip lands (live gate, fresh baseline)', !sleep.isCritterAsleep())
    const anchor = sleep.critterSwayAnchor()
    t.check('the wake flip re-stamped the anchor', anchor.at >= sleptAnchor.at)
    const k1 = sleep.critterLiveFrameKey(anchor.at + idle.SWAY_TICK_MS)
    const k2 = sleep.critterLiveFrameKey(anchor.at + idle.SWAY_TICK_MS * 2)
    const k3 = sleep.critterLiveFrameKey(anchor.at + idle.SWAY_TICK_MS * 3)
    const phases = [k1, k2, k3].map(k => idle.readCritterFrameKey(k).swayPhase)
    t.check(
      'woken: the sway steps on every tick past the anchor (the wake-stall class)',
      phases[0] !== phases[1] && phases[1] !== phases[2],
      phases.join(','),
    )
    off2()
    sleep.resetCritterSleepForTests()
  }

  {
    const roster = await import('../../src/utils/cockpit/daemonRosterSnapshot.js')
    const aged = (): number => Date.now() - sleep.SLEEP_AFTER_MS * 3

    roster.primeDaemonCrewLivenessForProofs({ engaged: true, workersActive: true })
    sleep.resetCritterSleepForTests(aged())
    let off = sleep.subscribeCritterSleep(() => {})
    t.check('a live daemon worker keeps an aged-quiet session awake', !sleep.isCritterAsleep())
    off()

    roster.primeDaemonCrewLivenessForProofs({ engaged: true, workersActive: false })
    sleep.resetCritterSleepForTests(aged())
    off = sleep.subscribeCritterSleep(() => {})
    {
      const stats = sleep.critterSleepStatsForProofs()
      t.check('an idle roster does not hold it awake (the contrast leg)', stats.asleep, JSON.stringify(stats))
      t.check('asleep + daemon ENGAGED ⇒ the elapse clock stays armed', stats.clockArmed, JSON.stringify(stats))
    }
    off()

    roster.primeDaemonCrewLivenessForProofs({ engaged: false, workersActive: false })
    sleep.resetCritterSleepForTests(aged())
    off = sleep.subscribeCritterSleep(() => {})
    {
      const stats = sleep.critterSleepStatsForProofs()
      t.check('asleep + daemon OFF ⇒ the clock is dropped (the original law)', stats.asleep && !stats.clockArmed, JSON.stringify(stats))
    }
    off()
    roster.primeDaemonCrewLivenessForProofs(null)
    sleep.resetCritterSleepForTests()

    const src = await Bun.file('src/utils/cockpit/critterSleep.ts').text()
    t.check(
      'the live predicate composes the plane AND the daemon roster mirror',
      /agentsActiveNow\(\) \|\| daemonCrewLivenessSync\(\)\.workersActive/.test(src),
      'source lock',
    )
    t.check(
      'the asleep clock exception keys on daemon engagement',
      /sleepSince === 0 \|\| daemonCrewLivenessSync\(\)\.engaged/.test(src),
      'source lock',
    )
  }

  {
    sleep.resetCritterSleepForTests()
    process.env['MERCURY_CRITTER_SLEEP'] = '1'
    const off = sleep.subscribeCritterSleep(() => {})
    const now = Date.now()
    const zAt = (t2: number): number | null =>
      idle.readCritterFrameKey(sleep.critterLiveFrameKey(t2)).sleepPhase
    const advancing =
      zAt(now) !== zAt(now + idle.SLEEP_TICK_MS) ||
      zAt(now + idle.SLEEP_TICK_MS) !== zAt(now + 2 * idle.SLEEP_TICK_MS)
    t.check('epoch-based sampling advances the z against the real stamps', advancing)
    off()
    delete process.env['MERCURY_CRITTER_SLEEP']
    sleep.resetCritterSleepForTests()
  }
}

t.section('§9 — the mood WORD rides the SAME verdict as the art')
{
  const eng = await import('../../src/utils/cockpit/companionEngine.js')
  const signals = await import('../../src/utils/cockpit/companionSignals.js')

  const agree = (): boolean =>
    (eng.companionEngineSnapshot().mood === 'sleeping') === sleep.isCritterAsleep()

  sleep.resetCritterSleepForTests()
  eng.resetCompanionEngineForTests()
  process.env['MERCURY_CRITTER_SLEEP'] = '1'
  const off = eng.subscribeCompanionEngine(() => {})
  t.check(
    'forced-asleep: the art sleeps AND the mood word is sleeping (one truth)',
    sleep.isCritterAsleep() && eng.companionEngineSnapshot().mood === 'sleeping' && agree(),
    JSON.stringify({ mood: eng.companionEngineSnapshot().mood, asleep: sleep.isCritterAsleep() }),
  )

  process.env['MERCURY_CRITTER_SLEEP'] = '0'
  signals.publishCompanionTurn({ turnLive: true, streaming: false, awaitingPermission: false })
  t.check(
    'hard-off + a live turn: awake art, a working word — still agreeing',
    !sleep.isCritterAsleep() && eng.companionEngineSnapshot().mood === 'working' && agree(),
    JSON.stringify({ mood: eng.companionEngineSnapshot().mood, asleep: sleep.isCritterAsleep() }),
  )

  signals.publishCompanionTurn({ turnLive: false, streaming: false, awaitingPermission: false })
  t.check(
    "hard-off quiet: the word is idle/done — no private timer can ever say 'sleeping'",
    !sleep.isCritterAsleep() && eng.companionEngineSnapshot().mood !== 'sleeping' && agree(),
    eng.companionEngineSnapshot().mood,
  )

  off()
  delete process.env['MERCURY_CRITTER_SLEEP']
  const stats = sleep.critterSleepStatsForProofs()
  t.check('engine unsubscribe releases the sleep store', stats.listeners === 0, JSON.stringify(stats))
  sleep.resetCritterSleepForTests()
  eng.resetCompanionEngineForTests()
  signals.resetCompanionSignals()
}

t.section('§10 — THE WAKE EDGES (the operator\'s word): a turn wakes, a view never does')
{
  const signals = await import('../../src/utils/cockpit/companionSignals.js')
  const aged = (): number => Date.now() - sleep.SLEEP_AFTER_MS * 3

  sleep.resetCritterSleepForTests(aged())
  let off = sleep.subscribeCritterSleep(() => {})
  t.check('aged-quiet store is asleep (the wake legs start from real sleep)', sleep.isCritterAsleep())
  t.check(
    'asleep with daemon OFF: no clock is armed — the dispatch stamp must be a push',
    !sleep.critterSleepStatsForProofs().clockArmed,
  )
  sleep.noteCritterRealActivity()
  t.check(
    'a Minerva/Console DISPATCH wakes the critter in the same tick (push, no poll)',
    !sleep.isCritterAsleep(),
  )
  off()

  sleep.resetCritterSleepForTests(aged())
  off = sleep.subscribeCritterSleep(() => {})
  t.check('aged-quiet store is asleep again (path-2 baseline)', sleep.isCritterAsleep())
  signals.publishCompanionTurn({ turnLive: true, streaming: false, awaitingPermission: false })
  t.check('a session TURN wakes it through the published signal edge', !sleep.isCritterAsleep())
  signals.publishCompanionTurn({ turnLive: false, streaming: false, awaitingPermission: false })
  t.check('the turn END keeps it awake (grace counts from the end stamp)', !sleep.isCritterAsleep())
  off()
  signals.resetCompanionSignals()

  sleep.resetCritterSleepForTests(aged())
  off = sleep.subscribeCritterSleep(() => {})
  const first = sleep.isCritterAsleep()
  const off2 = sleep.subscribeCritterSleep(() => {})
  t.check(
    'mounting a viewer (fresh subscription) NEVER wakes an asleep critter',
    first && sleep.isCritterAsleep(),
    JSON.stringify(sleep.critterSleepStatsForProofs()),
  )
  off2()
  off()
  sleep.resetCritterSleepForTests()

  const minervaSrc = await Bun.file('src/utils/tabula/minerva.ts').text()
  const consoleSrc = await Bun.file('src/utils/cockpit/helmConsoleAsk.ts').text()
  t.check(
    'both Minerva runners stamp the wake at dispatch',
    (minervaSrc.match(/noteCritterRealActivity\(\)/g) ?? []).length === 2,
  )
  t.check(
    'the console ask stamps at dispatch and settle',
    (consoleSrc.match(/noteCritterRealActivity\(\)/g) ?? []).length === 2,
  )
  {
    const { execSync } = await import('node:child_process')
    let viewCalls = ''
    try {
      viewCalls = execSync(
        "grep -rl 'noteCritterRealActivity' src/components src/screens 2>/dev/null || true",
        { encoding: 'utf8' },
      ).trim()
    } catch {
      viewCalls = ''
    }
    t.check(
      'no component or screen calls the wake seam (a view can never stamp work)',
      viewCalls === '',
      viewCalls,
    )
  }
}

t.section('§11 — the per-critter SLEEP GLYPH LADDER (bubbles for the clam, Zzz for the rest)')
{
  const { displayWidth } = await import('../../src/components/mercury-ui/glyphs.js')
  const byName = Object.fromEntries(cd.CRITTERS.map(d => [d.name, d]))
  const expected: Record<string, string> = {
    crab: cd.SLEEP_GLYPHS_DEFAULT,
    octopus: cd.SLEEP_GLYPHS_DEFAULT,
    jellyfish: cd.SLEEP_GLYPHS_DEFAULT,
    clam: cd.CLAM_SLEEP_GLYPHS,
  }
  t.check('the default ladder IS the Zzz', cd.SLEEP_GLYPHS_DEFAULT === 'zzz', cd.SLEEP_GLYPHS_DEFAULT)
  t.check("the clam's ladder is bubbles of two sizes, alternating big/small — o°o° (operator wording), never the °o° face", cd.CLAM_SLEEP_GLYPHS === 'o°o°' && cd.CLAM_SLEEP_GLYPHS !== cd.SLEEP_GLYPHS_DEFAULT, cd.CLAM_SLEEP_GLYPHS)
  t.check('a ladder is the climb length or one more (the climb adds one glyph per phase and ends whole)', cd.SLEEP_GLYPHS_MAX === cd.SLEEP_PHASES + 1)
  for (const def of cd.CRITTERS) {
    const ladder = cd.sleepGlyphsFor(def)
    t.check(`${def.name}: sleeps under ${JSON.stringify(expected[def.name])}`, ladder === expected[def.name], ladder)
    const chars = [...ladder]
    t.check(`${def.name}: the ladder is between the climb length and SLEEP_GLYPHS_MAX glyphs`, chars.length >= cd.SLEEP_PHASES && chars.length <= cd.SLEEP_GLYPHS_MAX, String(chars.length))
    t.check(`${def.name}: the slot count IS the ladder length`, cd.sleepSlotCountFor(def) === chars.length, String(cd.sleepSlotCountFor(def)))
    t.check(`${def.name}: every ladder glyph is single-width on the wire`, chars.every(ch => displayWidth(ch) === 1), chars.map(ch => `${ch}=${displayWidth(ch)}`).join(' '))
    t.check(`${def.name}: no emoji-eligible glyph in the ladder (no variation selector, nothing pictographic)`, !/[\u{1F300}-\u{1FAFF}\u{FE0F}\u{FE0E}]/u.test(ladder))
  }
  t.check('the Zzz path is byte-identical to before ladders existed (three slots, z → zz → zzz)', cd.sleepSlotCountFor(byName['crab']!) === 3 && cd.sleepSlotCountFor(byName['crab']!) === cd.SLEEP_PHASES)
  t.check(
    'the ladder rides the tinted wrappers (the mini/berth spread the def — the name is not the key)',
    cd.sleepGlyphsFor({ ...byName['clam']!, hue: '#000000', hueDeep: '#000000', art: cd.miniArtFor('clam') }) === cd.CLAM_SLEEP_GLYPHS,
  )
  t.check('a malformed ladder degrades to the Zzz (total, never a blank sleep)', cd.sleepGlyphsFor({ sleepGlyphs: 'zz' }) === cd.SLEEP_GLYPHS_DEFAULT && cd.sleepGlyphsFor({ sleepGlyphs: 'zzzzz' }) === cd.SLEEP_GLYPHS_DEFAULT && cd.sleepGlyphsFor({ sleepGlyphs: '' }) === cd.SLEEP_GLYPHS_DEFAULT && cd.sleepGlyphsFor({}) === cd.SLEEP_GLYPHS_DEFAULT)
  for (const def of cd.CRITTERS) {
    for (const form of ['art', 'hero', 'mini'] as const) {
      const pose = cd.sleepPoseFor(def, form)!
      const count = cd.sleepSlotCountFor(def)
      const slots = cd.sleepZzzSlots(pose.art, count)
      const ladder = [...cd.sleepGlyphsFor(def)]
      const painted = slots.map(c => cd.sleepGlyphAt(def, slots, c)).join('')
      t.check(`${def.name}/${form}: one slot per ladder glyph, painting the ladder left→right`, slots.length === ladder.length && painted === ladder.join(''), painted)
      const litAt = (p: number): number[] => slots.filter(c => cd.sleepZzzArt(pose.art, p, count)[0]![c] === cd.SLEEP_CELL)
      const first = litAt(0)
      const wantFirst = Math.max(1, ladder.length - (cd.SLEEP_PHASES - 1))
      t.check(`${def.name}/${form}: phase 0 lights the rightmost ${wantFirst} slot(s) — the ladder's tail`, first.length === wantFirst && first.every((c, i) => c === slots[slots.length - wantFirst + i]), first.join(','))
      t.check(`${def.name}/${form}: the climb adds one glyph per phase and ends whole`, litAt(1).length === wantFirst + 1 && litAt(2).length === ladder.length)
      const full = cd.sleepZzzArt(pose.art, 2, count)
      t.check(`${def.name}/${form}: the full frame writes the slots and nothing else`, full.slice(2).every((r, i) => r === pose.art[i + 2]) && [...full[0]!].every((ch, c) => ch === (slots.includes(c) ? cd.SLEEP_CELL : pose.art[0]![c])))
    }
  }
  t.check('the clam climbs o° → °o° → o°o° on its hero pose', (() => {
    const pose = cd.sleepPoseFor(byName['clam']!, 'hero')!
    const count = cd.sleepSlotCountFor(byName['clam']!)
    const slots = cd.sleepZzzSlots(pose.art, count)
    const frame = (p: number): string => slots.map(c => (cd.sleepZzzArt(pose.art, p, count)[0]![c] === cd.SLEEP_CELL ? cd.sleepGlyphAt(byName['clam']!, slots, c) : ' ')).join('').trim()
    return frame(0) === 'o°' && frame(1) === '°o°' && frame(2) === 'o°o°'
  })())
  t.check('a column outside the slots is total (falls to the last glyph, never undefined)', cd.sleepGlyphAt(byName['clam']!, [20, 21, 22, 23], 0) === '°' && cd.sleepGlyphAt(byName['crab']!, [], 5) === 'z')

  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { CritterArt } = await import('../../src/components/mercury-ui/CritterArt.js')
  const render = async (def: (typeof cd.CRITTERS)[number], props: Record<string, unknown>): Promise<string> =>
    renderToString(React.createElement(CritterArt, { def, ...props }), 60)
  const clam = byName['clam']!
  const crab = byName['crab']!
  const clamHero = await render(clam, { pupil: idle.EYE_SHUT, sleepPhase: 2, hero: true })
  t.check('RENDERED clam hero asleep: the bubbles o°o° paint over the shut shell', clamHero.includes('o°o°'), JSON.stringify(clamHero.split('\n')[0]))
  t.check('RENDERED clam hero asleep: not one z on screen', !/z/.test(clamHero))
  const clamHero1 = await render(clam, { pupil: idle.EYE_SHUT, sleepPhase: 1, hero: true })
  t.check('RENDERED clam hero asleep at phase 1: three bubbles (°o°), the fourth still to rise', clamHero1.includes('°o°') && !clamHero1.includes('o°o°'), JSON.stringify(clamHero1.split('\n')[0]))
  const clamMini = await render({ ...clam, art: cd.miniArtFor('clam') }, { pupil: idle.EYE_SHUT, sleepPhase: 2, mini: true })
  t.check('RENDERED clam mini asleep: the bubbles paint at three lines too', clamMini.includes('o°o°') && !/z/.test(clamMini), JSON.stringify(clamMini.split('\n')[0]))
  const clamFlat = await render(clam, { pupil: idle.EYE_SHUT, sleepPhase: 0 })
  t.check('RENDERED clam flat asleep at phase 0: the first two bubbles (o°) alone', /(^|\s)o°(\s|$)/m.test(clamFlat) && !/°o°/.test(clamFlat) && !/z/.test(clamFlat), JSON.stringify(clamFlat.split('\n')[0]))
  const clamChunky = await render(clam, { pupil: idle.EYE_SHUT, sleepPhase: 2, chunky: true })
  t.check('RENDERED clam chunky asleep: the bubbles ride the chunky seam too', /o\s+°\s+o\s+°/.test(clamChunky) && !/z/.test(clamChunky), JSON.stringify(clamChunky.split('\n')[0]))
  const crabHero = await render(crab, { pupil: idle.EYE_SHUT, sleepPhase: 2, hero: true })
  t.check('RENDERED crab hero asleep: the Zzz is untouched', crabHero.includes('zzz') && !/[°o]/.test(crabHero), JSON.stringify(crabHero.split('\n')[0]))
  const crabHero0 = await render(crab, { pupil: idle.EYE_SHUT, sleepPhase: 0, hero: true })
  t.check('RENDERED crab hero asleep at phase 0: the lone z (the historical climb, untouched)', /(^|\s)z(\s|$)/m.test(crabHero0) && !crabHero0.includes('zz'), JSON.stringify(crabHero0.split('\n')[0]))
  const clamAwake = await render(clam, { hero: true })
  t.check('RENDERED clam hero awake: no bubble, no z', !/[°oz]/.test(clamAwake))

  const painter = await Bun.file('src/components/mercury-ui/CritterArt.tsx').text()
  const slotsAt = painter.indexOf('sleepZzzSlots(art, sleepSlotCount)')
  const writeAt = painter.indexOf('sleepZzzArt(art, sleepPhase, sleepSlotCount)')
  t.check('the painter reads the slots BEFORE writing the glyph cells, both at the ladder\'s count', slotsAt > 0 && writeAt > slotsAt && /const sleepSlotCount = sleepSlotCountFor\(def\)/.test(painter), `slots@${slotsAt} write@${writeAt}`)
  t.check('both seams paint through sleepGlyphAt (one owner)', (painter.match(/sleepGlyphAt\(def, sleepSlots, c\)/g) ?? []).length === 2)
  t.check('no literal z paint survives in the painter', !/SLEEP_CELL\.repeat\(|\$\{SLEEP_CELL\} /.test(painter))
}

t.section('§12 — the VALVE SETTLE: the clam breathes with its shell, never sways it')
{
  const { heroEyeClusters } = await import('../../src/utils/cockpit/critterGaze.js')
  const clam = cd.CRITTERS.find(d => d.name === 'clam')!
  const specksOf = (art: string[]): string[] => {
    const found: string[] = []
    for (let r = 0; r < art.length; r++) {
      for (let c = 0; c < art[r]!.length; c++) {
        if (art[r]![c] === '.') continue
        let touched = false
        for (let dr = -1; dr <= 1 && !touched; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if ((dr !== 0 || dc !== 0) && (art[r + dr]?.[c + dc] ?? '.') !== '.') {
              touched = true
              break
            }
          }
        }
        if (!touched) found.push(`${r}:${c}`)
      }
    }
    return found
  }
  const pPairs = (art: string[]): string =>
    art
      .flatMap((row, r) => (r % 2 === 0 ? [...row].map((ch, c) => (ch === 'P' && art[r + 1]?.[c] === 'P' ? `${r}:${c}` : '')) : []))
      .filter(Boolean)
      .join(' ')

  for (const def of cd.CRITTERS) {
    for (const form of ['art', 'hero', 'mini'] as const) {
      if (def.name === 'clam') {
        t.check(`clam/${form}: authors a settle`, cd.settleDepthFor(def, form) > 0, String(cd.settleDepthFor(def, form)))
        t.check(`clam/${form}: ZERO flow — the valves never shear`, cd.flowDepthFor(def, form) === 0, String(cd.flowDepthFor(def, form)))
      } else {
        t.check(`${def.name}/${form}: no settle (the shell motion is the clam's alone)`, cd.settleDepthFor(def, form) === 0)
      }
    }
  }

  const settlePhases = [...Array(cd.SWAY_PHASES).keys()].filter(p => cd.settleRows(['M', 'M', '.'], 1, p).join('') !== 'MM.')
  t.check('the settle phases are a MINORITY of the cycle (the open pose dominates)', settlePhases.length > 0 && settlePhases.length * 2 < cd.SWAY_PHASES, settlePhases.join(','))

  for (const form of ['art', 'hero', 'mini'] as const) {
    const awake: string[] = form === 'hero' ? clam.heroArt! : form === 'mini' ? cd.miniArtFor('clam') : clam.art
    const depth = cd.settleDepthFor(clam, form)
    const rest = [...Array(cd.SWAY_PHASES).keys()].filter(p => !settlePhases.includes(p))
    t.check(`clam/${form}: every rest phase is the authored grid byte for byte`, rest.every(p => cd.settleRows(awake, depth, p).join('\n') === awake.join('\n')))
    const settled = cd.settleRows(awake, depth, settlePhases[0]!)
    t.check(`clam/${form}: the settle frame differs (the dip is visible)`, settled.join('\n') !== awake.join('\n'))
    t.check(`clam/${form}: geometry preserved (row count + every width)`, settled.length === awake.length && settled.every((r, i) => r.length === awake[i]!.length))
    t.check(`clam/${form}: row 0 empties and rows 1…depth are the valve rows shifted down`, /^\.+$/.test(settled[0]!) && settled.slice(1, depth + 1).every((r, i) => r === awake[i]))
    t.check(`clam/${form}: every row below the settle depth is byte-identical`, settled.slice(depth + 1).every((r, i) => r === awake[depth + 1 + i]))
    t.check(`clam/${form}: the covered row carries no eye letter (E/K/P) — the settle never touches an eye`, !/[EKP]/.test(awake[depth]!), awake[depth]!)
    const [aS, aE] = cd.heroContentBounds(awake)
    const [sS, sE] = cd.heroContentBounds(settled)
    t.check(`clam/${form}: content bounds unchanged (the mount's width budget holds)`, aS === sS && aE === sE, `[${sS},${sE}) vs [${aS},${aE})`)
    t.check(`clam/${form}: no detached fragments on the settle frame`, specksOf(settled).length === 0, specksOf(settled).join(' '))
    if (form === 'hero') {
      const before = heroEyeClusters(awake).map(cl => `${cl.rest.r},${cl.rest.c}:${cl.cells.length}`).join('|')
      const after = heroEyeClusters(settled).map(cl => `${cl.rest.r},${cl.rest.c}:${cl.cells.length}`).join('|')
      t.check('clam/hero: both eye clusters survive the settle in place (gaze + blink still key on them)', before === after && heroEyeClusters(settled).length === 2, after)
    } else {
      t.check(`clam/${form}: the P-over-P eye pairs survive the settle in place (the pupil seam still fires)`, pPairs(settled) === pPairs(awake) && pPairs(awake).length > 0, pPairs(settled))
    }
    t.check(`clam/${form}: depth 0 is the identity`, cd.settleRows(awake, 0, settlePhases[0]!).join('\n') === awake.join('\n'))
    t.check(`clam/${form}: an out-of-range depth is the identity, never a throw`, cd.settleRows(awake, awake.length, settlePhases[0]!).join('\n') === awake.join('\n'))
  }

  const painter = await Bun.file('src/components/mercury-ui/CritterArt.tsx').text()
  t.check('the painter settles at depth 0 for a sleep pose', /const settleDepth = pose \? 0 : settleDepthFor\(def, form\)/.test(painter))
  const breathAt = painter.indexOf('sleepBreathArt(')
  const settleAt = painter.indexOf('settleRows(')
  const swayAt = painter.indexOf('swayRows(')
  t.check('the settle is applied AFTER the breath and BEFORE the sway (and the slice)', breathAt > 0 && settleAt > breathAt && swayAt > settleAt && settleAt < painter.indexOf('heroContentBounds(rows)'), `breath@${breathAt} settle@${settleAt} sway@${swayAt}`)
  t.check('all three render paths (hero + square + flat/mini) settle', (painter.match(/settleRows\(breathed, settleDepth, swayPhase\)/g) ?? []).length === 3)
}

t.section('§13 — the ladder\'s three conditions: the Zzz path byte-identical (base A/B) · the width law at four · reduced motion holds the whole ladder')
{
  const { readFileSync } = await import('node:fs')
  const { composeZzzFrames, ZZZ_FIXTURE_PATH } = await import('./zzzFrames.ts')
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { CritterArt } = await import('../../src/components/mercury-ui/CritterArt.js')
  const render = async (def: (typeof cd.CRITTERS)[number], props: Record<string, unknown>): Promise<string> =>
    renderToString(React.createElement(CritterArt, { def, ...props }), 60)
  const fixture = JSON.parse(readFileSync(ZZZ_FIXTURE_PATH, 'utf8')) as {
    frames: Array<{ critter: string; form: string; state: string; grid: string[]; plain: string; ansi: string; zTint: string }>
  }
  t.check('the fixture holds every pool critter × 3 forms × 4 states (non-vacuous)', fixture.frames.length === 4 * 3 * 4, String(fixture.frames.length))
  const current = await composeZzzFrames(process.cwd())
  const key = (f: { critter: string; form: string; state: string }): string => `${f.critter}/${f.form}/${f.state}`
  const cur = new Map(current.map(f => [key(f), f]))
  const sameBytes = (a: (typeof fixture.frames)[number], b: (typeof current)[number]): boolean =>
    JSON.stringify(a.grid) === JSON.stringify(b.grid) && a.plain === b.plain && a.ansi === b.ansi && a.zTint === b.zTint
  for (const name of ['crab', 'octopus', 'jellyfish']) {
    const mine = fixture.frames.filter(f => f.critter === name)
    const diffs = mine.filter(f => !cur.has(key(f)) || !sameBytes(f, cur.get(key(f))!)).map(key)
    t.check(`${name}: all ${mine.length} sleep/awake frames are BYTE-IDENTICAL to the pre-ladder base (grid + plain + ANSI + tint)`, mine.length === 12 && diffs.length === 0, diffs.join(' · '))
  }
  {
    const clamFrames = fixture.frames.filter(f => f.critter === 'clam')
    const changed = clamFrames.filter(f => cur.has(key(f)) && !sameBytes(f, cur.get(key(f))!))
    t.check('poison control: every clam frame DIFFERS from the base (the A/B is not vacuous)', clamFrames.length === 12 && changed.length === 12, `${changed.length}/${clamFrames.length}`)
    const z2 = cur.get('clam/hero/z2')!
    const baseZ2 = clamFrames.find(f => f.state === 'z2' && f.form === 'hero')!
    t.check('…and the difference at the glyph slot is exactly bubbles for a Zzz', baseZ2.plain.includes('zzz') && !baseZ2.plain.includes('o°') && z2.plain.includes('o°o°') && !/z/.test(z2.plain))
  }
  t.check('the fixture bytes are read from the committed path (regeneration is a deliberate act)', ZZZ_FIXTURE_PATH === 'scripts/critters/fixtures/zzz-frames.json')

  const clam = cd.CRITTERS.find(d => d.name === 'clam')!
  const four = cd.sleepSlotCountFor(clam)
  t.check('the clam\'s ladder needs four slots', four === 4, String(four))
  for (const form of ['art', 'hero', 'mini'] as const) {
    const pose = cd.sleepPoseFor(clam, form)!
    let sliced = pose.art
    if (form === 'hero') {
      const [s, e] = cd.heroContentBounds(pose.art)
      sliced = pose.art.map(r => r.slice(s, e))
    }
    const slots = cd.sleepZzzSlots(sliced, four)
    t.check(`clam/${form}: four slots exist on the sliced sleep pose`, slots.length === 4, JSON.stringify(slots))
    t.check(`clam/${form}: every slot lies inside the sliced width (never past the content edge)`, slots.every(c => c >= 0 && c < sliced[0]!.length), `${JSON.stringify(slots)} < ${sliced[0]!.length}`)
    t.check(`clam/${form}: every slot is empty in BOTH rows of the top pair (no content cell stolen)`, slots.every(c => sliced[0]![c] === '.' && sliced[1]![c] === '.'))
    for (let p = 0; p < cd.SLEEP_PHASES; p++) {
      const frame = cd.sleepZzzArt(sliced, p, four)
      const damaged: string[] = []
      frame.forEach((row, i) => {
        for (let c = 0; c < row.length; c++) {
          if (row[c] !== sliced[i]![c] && !(sliced[i]![c] === '.' && row[c] === cd.SLEEP_CELL && slots.includes(c) && i < 2)) damaged.push(`${i}:${c}`)
        }
      })
      t.check(`clam/${form} phase ${p}: only the slots change, every width preserved`, damaged.length === 0 && frame.every((r, i) => r.length === sliced[i]!.length), damaged.join(','))
    }
    const renderDef = form === 'mini' ? { ...clam, art: cd.miniArtFor('clam') } : clam
    const budget = sliced[0]!.length
    t.check(`clam/${form}: the sleep pose's width IS the awake budget (${budget})`, budget === (form === 'hero' ? cd.heroContentBounds(clam.heroArt!)[1] - cd.heroContentBounds(clam.heroArt!)[0] : form === 'mini' ? cd.miniArtFor('clam')[0]!.length : clam.art[0]!.length), String(budget))
    const awakeW = Math.max(...(await render(renderDef, { hero: form === 'hero', mini: form === 'mini', swayPhase: 0 })).split('\n').map(l => l.length))
    t.check(`clam/${form}: the awake render fits the budget (${awakeW} ≤ ${budget})`, awakeW <= budget)
    for (let p = 0; p < cd.SLEEP_PHASES; p++) {
      const out = await render(renderDef, { hero: form === 'hero', mini: form === 'mini', swayPhase: 0, pupil: idle.EYE_SHUT, sleepPhase: p })
      const w = Math.max(...out.split('\n').map(l => l.length))
      t.check(`clam/${form} phase ${p}: the asleep render, bubbles included, fits the same budget (${w} ≤ ${budget})`, w <= budget, `${w} vs ${budget}`)
    }
    const awakeGrid = form === 'hero' ? clam.heroArt! : form === 'mini' ? cd.miniArtFor('clam') : clam.art
    const awakeSlots = cd.sleepZzzSlots(awakeGrid, four)
    t.check(`clam/${form} awake grid at count 4: every slot is an empty top-pair cell (the crown is never overwritten)`, awakeSlots.every(c => awakeGrid[0]![c] === '.' && awakeGrid[1]![c] === '.'), JSON.stringify(awakeSlots))
  }

  const animated = await Bun.file('src/components/mercury-ui/AnimatedCritterArt.tsx').text()
  t.check('the static (reduced-motion) branch renders the FULL sleep phase', /pupil=\{EYE_SHUT\} sleepPhase=\{2\}/.test(animated) && cd.SLEEP_PHASES - 1 === 2)
  for (const def of cd.CRITTERS) {
    const count = cd.sleepSlotCountFor(def)
    const pose = cd.sleepPoseFor(def, 'hero')!
    const lit = cd.sleepZzzSlots(pose.art, count).filter(c => cd.sleepZzzArt(pose.art, cd.SLEEP_PHASES - 1, count)[0]![c] === cd.SLEEP_CELL)
    t.check(`${def.name}: the full phase lights the WHOLE ladder (${count} of ${count})`, lit.length === count, String(lit.length))
  }
  {
    const { AnimatedCritterArt } = await import('../../src/components/mercury-ui/AnimatedCritterArt.js')
    const prevIdle = process.env['MERCURY_CRITTER_IDLE']
    process.env['MERCURY_CRITTER_IDLE'] = '0'
    process.env['MERCURY_CRITTER_SLEEP'] = '1'
    sleep.resetCritterSleepForTests()
    const still = async (def: (typeof cd.CRITTERS)[number]): Promise<string> =>
      renderToString(React.createElement(AnimatedCritterArt, { def, hero: true }), 60)
    const clamStill = await still(clam)
    const crabStill = await still(cd.CRITTERS[0]!)
    t.check('RENDERED AnimatedCritterArt, animation OFF + forced asleep: the clam holds the whole o°o° still', clamStill.includes('o°o°') && !/z/.test(clamStill), JSON.stringify(clamStill.split('\n')[0]))
    t.check('RENDERED AnimatedCritterArt, animation OFF + forced asleep: the crab holds its whole zzz still', crabStill.includes('zzz') && !/[°o]/.test(crabStill), JSON.stringify(crabStill.split('\n')[0]))
    delete process.env['MERCURY_CRITTER_SLEEP']
    if (prevIdle === undefined) delete process.env['MERCURY_CRITTER_IDLE']
    else process.env['MERCURY_CRITTER_IDLE'] = prevIdle
    sleep.resetCritterSleepForTests()
  }
}

t.finish('CRITTER-SLEEP')
