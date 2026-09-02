#!/usr/bin/env bun
// ============================================================================
//  prove-critter-gaze — the mouse-tracking gaze's PURE core + hardening.
//
//  The gaze contract (critterGaze.ts): pupils move ONLY inside their authored
//  eye clusters, never off their half-block row-pair, neutral is the SAME
//  array reference, K-count is conserved, a foreign key refuses wholesale,
//  and the blink lid covers a moved pupil. Every invariant here is the pure
//  function — no PTY, no React (prove-critter-gaze-live drives the real
//  binary with synthetic SGR motion for the wiring).
// ============================================================================
import {
  applyGazeKey,
  critterGazeEnabled,
  GAZE_DEAD_ZONE,
  gazeKeyForPointer,
  heroEyeClusters,
  heroGazeRows,
} from '../../src/utils/cockpit/critterGaze.js'
import {
  clearPointerCell,
  getPointerCell,
  getPointerCellKey,
  getPointerVersion,
  setPointerCell,
  subscribePointerCell,
} from '../../src/utils/cockpit/pointerCell.js'
import {
  CRITTERS,
  heroBlinkRows,
} from '../../src/utils/cockpit/critterData.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

// The POOL only. The dragon would otherwise stand in this list;
// the Concourse resident is NOT its replacement here, because it authors a
// single eye cluster by design (a profile view facing the sessions list) and
// this file's conservation laws assume the pool's two-eye language. Its own
// one-cluster gaze + blink laws are asserted in
// scripts/notifications/prove-concourse-critter.ts §4.
const ALL = [...CRITTERS].filter(d => d.heroArt?.length)

//
console.log('— pure core: neutral identity + conservation —')
for (const def of ALL) {
  const art = def.heroArt!
  t(`${def.name}: null pointer ⇒ same array ref`, heroGazeRows(art, null, null) === art)
  t(`${def.name}: '' key ⇒ same array ref`, applyGazeKey(art, '') === art)
  const clusters = heroEyeClusters(art)
  t(`${def.name}: eyes discovered (≥2 pupils authored)`, clusters.length >= 2, `${clusters.length}`)

  // A ring of pointers around the creature: every result conserves the grid.
  const H = art.length
  const W = Math.max(...art.map(r => r.length))
  for (const [px, py] of [
    [-30, H / 2],
    [W + 30, H / 2],
    [W / 2, -30],
    [W / 2, H + 30],
    [-20, -20],
    [W + 20, H + 20],
  ] as Array<[number, number]>) {
    const rows = heroGazeRows(art, px, py)
    const kBefore = art.join('').split('K').length - 1
    const kAfter = rows.join('').split('K').length - 1
    t(
      `${def.name} @(${px.toFixed(0)},${py.toFixed(0)}): K conserved + width preserved`,
      kAfter === kBefore && rows.every((r, i) => r.length === art[i]!.length),
    )
    // Every K sits inside SOME authored cluster, on the same row-pair as its
    // cluster's rest pupil.
    const clusterCells = new Set(
      clusters.flatMap(cl => cl.cells.map(c => `${c.r}:${c.c}`)),
    )
    let inside = true
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r]!.length; c++) {
        if (rows[r]![c] === 'K' && !clusterCells.has(`${r}:${c}`)) inside = false
      }
    }
    t(`${def.name} @(${px.toFixed(0)},${py.toFixed(0)}): pupils stay inside authored clusters`, inside)
  }
}

//
console.log('— direction correctness (crab) —')
const crab = ALL.find(d => d.name === 'crab')!.heroArt!
const crabClusters = heroEyeClusters(crab)
{
  // Pointer far LEFT, level with the eyes: every pupil should sit at its
  // cluster's leftmost column, on the pupil's own row (horizontal gaze).
  const eyeY = crabClusters[0]!.cy
  const rows = heroGazeRows(crab, -40, eyeY)
  for (const cl of crabClusters) {
    const minC = Math.min(...cl.cells.map(c => c.c))
    const kCells = cl.cells.filter(c => rows[c.r]![c.c] === 'K')
    t(
      `crab left-gaze: cluster@${cl.rest.r},${cl.rest.c} pupil at leftmost col`,
      kCells.length === 1 && kCells[0]!.c === minC,
      kCells.map(c => `${c.r},${c.c}`).join(' '),
    )
  }
  // Far RIGHT: rightmost column.
  const rowsR = heroGazeRows(crab, 80, eyeY)
  for (const cl of crabClusters) {
    const maxC = Math.max(...cl.cells.map(c => c.c))
    const kCells = cl.cells.filter(c => rowsR[c.r]![c.c] === 'K')
    t(
      `crab right-gaze: cluster@${cl.rest.r},${cl.rest.c} pupil at rightmost col`,
      kCells.length === 1 && kCells[0]!.c === maxC,
    )
  }
  // Straight UP from each eye: the pupil must move to the TOP pair row
  // (crab eyes are EEE over EKE — up = the row above the rest).
  const rowsU = heroGazeRows(crab, crabClusters[0]!.cx, -50)
  const upCl = crabClusters[0]!
  const kUp = upCl.cells.filter(c => rowsU[c.r]![c.c] === 'K')
  t('crab up-gaze: pupil on the top pair row', kUp.length === 1 && kUp[0]!.r === upCl.rest.r - 1)
  // THE GAZE LAW: ONE gaze source feeds both
  // eyes. The dead zone is the FACE's — one distance, one verdict — so a
  // pointer resting ON one eye moves BOTH pupils toward it with the same
  // offset (the per-eye split this replaced left one eye at rest while the
  // other tracked: the wall-eyed class).
  const farCl = crabClusters[1]!
  const nearRows = heroGazeRows(crab, upCl.cx, upCl.cy)
  const offsetsOn = (rows: string[]): string[] =>
    crabClusters.map(cl => {
      const k = cl.cells.find(c => rows[c.r]![c.c] === 'K')
      return k ? `${k.r - cl.rest.r},${k.c - cl.rest.c}` : 'none'
    })
  {
    const offs = offsetsOn(nearRows)
    t(
      'gaze law: pointer ON the left eye moves BOTH pupils, same offset, toward it',
      offs.every(o => o === offs[0] && o !== 'none') && offs[0] !== '0,0' && offs[0]!.endsWith(',-1'),
      offs.join(' | '),
    )
  }
  // …and the FACE centroid is the dead zone's anchor: a pointer between the
  // eyes at face height reads "right here" and keeps the authored rest.
  const faceX = (upCl.cx + farCl.cx) / 2
  const faceY = (upCl.cy + farCl.cy) / 2
  const restRows = heroGazeRows(crab, faceX + (GAZE_DEAD_ZONE - 0.5), faceY)
  t(
    'gaze law: a pointer inside the FACE dead zone keeps the authored rest pose',
    restRows === crab,
  )
}

//
console.log('— hysteresis (refinement): boundary drift never jitters —')
{
  const cl = crabClusters[0]!
  // Sweep a fine pointer arc far from the eye; WITH the previous key fed
  // back, the pupil may only change target when the angle deliberately moves
  // — count the flips and require the sticky path to flip strictly less than
  // a boundary-straddling stateless sweep would (which alternates).
  const arc = (deg: number): [number, number] => [
    cl.cx + 30 * Math.cos((deg * Math.PI) / 180),
    cl.cy + 30 * Math.sin((deg * Math.PI) / 180),
  ]
  // Find a decision boundary: two nearby angles whose STATELESS keys differ.
  let boundary: number | null = null
  for (let d = 0; d < 360 && boundary == null; d += 2) {
    const [ax, ay] = arc(d)
    const [bx, by] = arc(d + 2)
    const ka = gazeKeyForPointer(crab, ax, ay)
    const kb = gazeKeyForPointer(crab, bx, by)
    if (ka && kb && ka !== kb) boundary = d
  }
  t('a decision boundary exists on the far arc (fixture sane)', boundary != null)
  if (boundary != null) {
    // Oscillate ±1° across the boundary: stateless flips every step; the
    // sticky path holds one target throughout.
    // Straddle with the EXACT pair of angles whose stateless keys differ —
    // the crossing is between them by construction.
    let prev = ''
    const seen = new Set<string>()
    let statelessFlips = 0
    let lastStateless = ''
    for (let i = 0; i < 8; i++) {
      const d = i % 2 === 0 ? boundary : boundary + 2
      const [x, y] = arc(d)
      prev = gazeKeyForPointer(crab, x, y, prev)
      seen.add(prev)
      const sl = gazeKeyForPointer(crab, x, y)
      if (lastStateless && sl !== lastStateless) statelessFlips++
      lastStateless = sl
    }
    t('the boundary straddle flips the STATELESS key (repro sane)', statelessFlips >= 3)
    t('the sticky key holds ONE target across the straddle', seen.size === 1)
  }
  // A deliberate swing still re-aims — through ADJACENT offsets (the gaze
  // law's sweep): far-left key fed as prev, pointer far-right ⇒ the walk
  // reaches the stateless right key within two events, one step per event,
  // never a full-throw teleport and never sticky-stuck on the left.
  const leftKey = gazeKeyForPointer(crab, -40, cl.cy)
  const statelessRight = gazeKeyForPointer(crab, 80, cl.cy)
  const offsetOf = (key: string): string => {
    const m = /^(\d+),(\d+)>(\d+),(\d+)/.exec(key)
    return m ? `${Number(m[3]) - Number(m[1])},${Number(m[4]) - Number(m[2])}` : '0,0'
  }
  const hops: string[] = []
  let prevSwing = leftKey
  for (let i = 0; i < 2; i++) {
    prevSwing = gazeKeyForPointer(crab, 80, cl.cy, prevSwing)
    hops.push(offsetOf(prevSwing))
  }
  const chebOk = hops.every((h, i) => {
    const [ar, ac] = (i === 0 ? offsetOf(leftKey) : hops[i - 1]!).split(',').map(Number)
    const [br, bc] = h.split(',').map(Number)
    return Math.max(Math.abs(ar! - br!), Math.abs(ac! - bc!)) <= 1
  })
  t('a real swing re-aims through adjacent steps', chebOk, hops.join(' → '))
  t('…and lands the full right throw within two events', prevSwing === statelessRight, `${prevSwing} vs ${statelessRight}`)
}

//
console.log('— blink composes over gaze —')
for (const def of ALL) {
  const art = def.heroArt!
  const gazed = heroGazeRows(art, -40, art.length / 2)
  const lidded = heroBlinkRows(gazed)
  let leak = false
  for (const row of lidded) if (/[EK]/.test(row)) {
    // Eye chars may survive ONLY on rows whose pair carries no pupil (e.g.
    // the dragon's horn-tip E cells) — exactly heroBlinkRows' contract. A
    // leak is an E/K on a row-pair that held a K.
    // (Recompute pairs from the GAZED grid — where the pupils actually are.)
  }
  const pairHasK = (rows: string[], i: number): boolean =>
    rows[i]!.includes('K') || (rows[i ^ 1]?.includes('K') ?? false)
  for (let i = 0; i < gazed.length; i++) {
    if (pairHasK(gazed, i) && /[EK]/.test(lidded[i]!)) leak = true
  }
  t(`${def.name}: lid covers every gazed eye row`, !leak)
}

//
console.log('— foreign/stale key refusal —')
{
  const octo = ALL.find(d => d.name === 'octopus')!.heroArt!
  const crabKey = gazeKeyForPointer(crab, -40, 2)
  t('crab key is non-empty (fixture sane)', crabKey.length > 0)
  t('crab key applied to octopus ⇒ REFUSED (same ref)', applyGazeKey(octo, crabKey) === octo)
  t('garbage key ⇒ REFUSED', applyGazeKey(crab, 'zz|1') === crab)
  t('out-of-bounds key ⇒ REFUSED', applyGazeKey(crab, '99,99>99,98') === crab)
  // Cross-pair move (row 1 → row 2) must refuse even if chars matched.
  t('cross-pair key ⇒ REFUSED', applyGazeKey(crab, '1,7>2,7') === crab)
}

//
console.log('— gate honesty —')
{
  const prev = process.env.MERCURY_CRITTER_GAZE
  process.env.MERCURY_CRITTER_GAZE = '0'
  t('MERCURY_CRITTER_GAZE=0 ⇒ disabled', critterGazeEnabled() === false)
  delete process.env.MERCURY_CRITTER_GAZE
  // default is ON under any stamp.
  t('default ⇒ enabled (stamp-independent )', critterGazeEnabled() === true)
  if (prev !== undefined) process.env.MERCURY_CRITTER_GAZE = prev
}

//
console.log('— pointer store: dedupe + edges —')
{
  clearPointerCell()
  const v0 = getPointerVersion()
  let fires = 0
  const unsub = subscribePointerCell(() => fires++)
  setPointerCell(4, 7)
  setPointerCell(4, 7) // same cell — deduped
  t('same-cell report deduped', fires === 1 && getPointerVersion() === v0 + 1)
  setPointerCell(5, 7)
  t('cell edge notifies', fires === 2 && getPointerCellKey() === '5,7')
  t('snapshot object stable shape', getPointerCell()?.col === 5 && getPointerCell()?.row === 7)
  clearPointerCell()
  t('clear notifies + nulls', fires === 3 && getPointerCell() === null && getPointerCellKey() === '')
  clearPointerCell() // idempotent
  t('clear idempotent', fires === 3)
  setPointerCell(Number.NaN, 2)
  t('non-finite report ignored', getPointerCell() === null)
  unsub()
  setPointerCell(9, 9)
  t('unsubscribe honored', fires === 3)
  clearPointerCell()
}

//
console.log('— view + decode wiring (static) —')
{
  const { readFileSync } = await import('node:fs')
  const app = readFileSync('src/ink/components/App.tsx', 'utf8')
  // Pins match the REAL current shape: the row/col decode lives in a
  // `toCell(atom)` helper (there is no `const row = m.row - 1;` literal),
  // and a literal pin carrying SEMICOLONS this file does not use makes
  // indexOf return -1 and the ordering compares vacuous. The WIRING IS LIVE
  // and correct (handleMouseEvent: the mouse-off guard, then
  // toCell, then the tap). Matched by
  // regex on the real shape, semicolon-agnostic, so a formatting pass
  // cannot silently blind them.
  const guardIdx = app.search(/if \(isMouseClicksDisabled\(\)\) return;?/)
  const decodeIdx = app.search(/const \{ col, row \} = toCell\(atom\);?/)
  const tapIdx = app.search(/setPointerCell\(col, row\);?/)
  t('App.handleMouseEvent decodes the pointer cell', decodeIdx > 0, `@${decodeIdx}`)
  t('…and taps the pointer store AFTER the decode', tapIdx > decodeIdx, `decode@${decodeIdx} tap@${tapIdx}`)
  t(
    'tap sits below the /mouse-off guard',
    guardIdx > 0 && guardIdx < tapIdx,
    `guard@${guardIdx} tap@${tapIdx}`,
  )
  const anim = readFileSync('src/components/mercury-ui/AnimatedCritterArt.tsx', 'utf8')
  // The gate carries a fourth term: a critter that has
  // fallen asleep does not track the pointer — a shut lid cannot, and leaving
  // it armed would hold the pointer store's subscription open for a creature
  // that is not looking at anything. Each term is pinned separately so the next
  // addition doesn't silently rewrite the whole gate.
  // The gaze extends to the square tier: the gate reads a derived
  // gazeGrid (hero art, or the square grid, else null) so the small berths'
  // eyes follow under the same one-source law. The pin follows both lines.
  t('gaze gated on animate + NOT asleep + a gaze grid (hero OR square) + critterGazeEnabled',
    /animate && !asleep && gazeGrid !== null && critterGazeEnabled\(\)/.test(anim) &&
    /const gazeGrid = usingHero \? def\.heroArt! : usingSquare \? def\.square : null/.test(anim))
  t('view threads gazeKey into CritterArt', anim.includes('gazeKey={gazeKey}'))
  const cart = readFileSync('src/components/mercury-ui/CritterArt.tsx', 'utf8')
  // RE-CUT: the base grid became `pose ? pose.art: def.heroArt!` —
  // asleep, an authored sleep pose replaces the awake art before every
  // transform. The ordering contract this leg pins is unchanged: gaze is
  // applied to the base FIRST, blink lids on top of the gazed rows.
  t('CritterArt applies gaze BEFORE blink', /applyGazeKey\(pose \? pose\.art : def\.heroArt!, gazeKey\)[\s\S]{0,400}heroBlinkRows\(gazed\)/.test(cart))
  const scen = readFileSync('scripts/ui/renderScenarios.ts', 'utf8')
  t('renderScenarios pins MERCURY_CRITTER_GAZE off', scen.includes("process.env.MERCURY_CRITTER_GAZE = process.env.MERCURY_CRITTER_GAZE ?? '0'"))
  const reg = readFileSync('src/substrate/flagRegistry.ts', 'utf8')
  t('flag registered', reg.includes("env: 'MERCURY_CRITTER_GAZE'"))
}

console.log(failures ? '\n❌ CRITTER-GAZE RED' : '\n✅ CRITTER-GAZE GREEN')
process.exit(failures)
