#!/usr/bin/env bun
import {
  applyGazeKey,
  GAZE_DEAD_ZONE,
  GAZE_MIN_COS,
  gazeKeyForPointer,
  heroEyeClusters,
} from '../../src/utils/cockpit/critterGaze.js'
import {
  composeCritterFrame,
} from '../../src/components/mercury-ui/CritterArt.js'
import {
  CRITTERS,
  miniArtFor,
  sleepPoseFor,
  type ArtForm,
  type CritterDef,
} from '../../src/utils/cockpit/critterData.js'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}


type Cell = { r: number; c: number }
type Cluster = { rest: Cell; cells: Cell[]; cx: number; cy: number }
type Offset = { dr: number; dc: number }

const off = (o: Offset): string => `${o.dr},${o.dc}`
const chebyshev = (a: Offset, b: Offset): number =>
  Math.max(Math.abs(a.dr - b.dr), Math.abs(a.dc - b.dc))

function sharedOffsetsOf(clusters: Cluster[]): Offset[] {
  if (clusters.length === 0) return []
  const hosts = (cl: Cluster, o: Offset): boolean =>
    cl.cells.some(c => c.r === cl.rest.r + o.dr && c.c === cl.rest.c + o.dc)
  const first = clusters[0]!
  const out: Offset[] = []
  for (const cell of first.cells) {
    const o = { dr: cell.r - first.rest.r, dc: cell.c - first.rest.c }
    if (o.dr === 0 && o.dc === 0) continue
    if (clusters.every(cl => hosts(cl, o))) out.push(o)
  }
  return out
}

function movesOf(key: string): Array<{ from: Cell; to: Cell }> {
  if (!key) return []
  const out: Array<{ from: Cell; to: Cell }> = []
  for (const part of key.split('|')) {
    const m = /^(\d+),(\d+)>(\d+),(\d+)$/.exec(part)
    if (!m) return []
    out.push({
      from: { r: Number(m[1]), c: Number(m[2]) },
      to: { r: Number(m[3]), c: Number(m[4]) },
    })
  }
  return out
}

function offsetOfKey(key: string): Offset | 'MIXED' | null {
  const moves = movesOf(key)
  if (moves.length === 0) return null
  const offs = moves.map(m => ({ dr: m.to.r - m.from.r, dc: m.to.c - m.from.c }))
  const first = offs[0]!
  return offs.every(o => o.dr === first.dr && o.dc === first.dc) ? first : 'MIXED'
}

function gazeKeyViolations(art: readonly string[], clusters: Cluster[], key: string): string[] {
  const bad: string[] = []
  const moves = movesOf(key)
  if (key && moves.length === 0) return [`unparseable key ${JSON.stringify(key)}`]
  if (moves.length !== 0 && moves.length !== clusters.length)
    bad.push(`moves ${moves.length} of ${clusters.length} eyes — eyes sampled apart`)
  const o = offsetOfKey(key)
  if (o === 'MIXED') bad.push('pupil offsets disagree across eyes')
  for (const mv of moves) {
    const cl = clusters.find(c => c.rest.r === mv.from.r && c.rest.c === mv.from.c)
    if (!cl) {
      bad.push(`move from ${mv.from.r},${mv.from.c} matches no rest cell`)
      continue
    }
    if (!cl.cells.some(c => c.r === mv.to.r && c.c === mv.to.c))
      bad.push(`target ${mv.to.r},${mv.to.c} outside its eye aperture`)
  }
  const applied = applyGazeKey([...art], key)
  const rows = new Set<number>()
  for (const cl of clusters) {
    for (const c of cl.cells) if (applied[c.r]?.[c.c] === 'K') rows.add(c.r - cl.rest.r)
  }
  if (rows.size > 1) bad.push(`pupil rows split across eyes: ${[...rows].join('/')}`)
  return bad
}


const POOL = [...CRITTERS]


function walk(art: readonly string[], points: Array<[number | null, number | null]>): { offsets: Offset[]; adjacent: boolean; detail: string } {
  let prev = ''
  let last: Offset = { dr: 0, dc: 0 }
  const offsets: Offset[] = []
  let adjacent = true
  let detail = ''
  for (const [px, py] of points) {
    const key = gazeKeyForPointer(art, px, py, prev)
    const o = offsetOfKey(key)
    const now: Offset = o === null || o === 'MIXED' ? { dr: 0, dc: 0 } : o
    if (o === 'MIXED') {
      adjacent = false
      detail = 'mixed key mid-walk'
    }
    if (chebyshev(last, now) > 1) {
      adjacent = false
      if (!detail) detail = `hop ${off(last)} → ${off(now)}`
    }
    offsets.push(now)
    last = now
    prev = key
  }
  return { offsets, adjacent, detail }
}


function pupilsOf(frame: string[]): Cell[] {
  const out: Cell[] = []
  for (let r = 0; r < frame.length; r++) {
    const row = frame[r]!
    for (let c = 0; c < row.length; c++) if (row[c] === 'K') out.push({ r, c })
  }
  return out
}


console.log('— §A the gaze census over the square tier —')
const SQUARE_SURFACES: Array<[string, (d: CritterDef) => string[]]> = [
  ['square dock', d => d.squareDock],
]
for (const def of CRITTERS) {
  for (const [label, gridOf] of SQUARE_SURFACES) {
    const art = gridOf(def)
    const clusters = heroEyeClusters(art) as Cluster[]
    const shared = sharedOffsetsOf(clusters)
    t(`${def.name} ${label}: ≥2 eyes with a shared aperture`, clusters.length >= 2 && shared.length >= 1, `eyes=${clusters.length} shared=${shared.length}`)
    t(
      `${def.name} ${label}: every shared offset is one step from rest (the walk's adjacency ground)`,
      shared.every(o => Math.max(Math.abs(o.dr), Math.abs(o.dc)) === 1),
      shared.map(off).join(' '),
    )
    const H = art.length
    const W = Math.max(...art.map(r => r.length))
    const prevSeeds = ['', ...shared.map(o => clusters.map(cl => `${cl.rest.r},${cl.rest.c}>${cl.rest.r + o.dr},${cl.rest.c + o.dc}`).join('|'))]
    let checked = 0
    const bad: string[] = []
    for (let py = -6; py <= H + 6; py += 2) {
      for (let px = -6; px <= W + 6; px += 2) {
        for (const prev of prevSeeds) {
          const key = gazeKeyForPointer(art, px, py, prev)
          checked++
          const v = gazeKeyViolations(art, clusters, key)
          if (v.length > 0 && bad.length < 4) bad.push(`@(${px},${py}): ${v[0]}`)
        }
      }
    }
    t(`${def.name} ${label}: every key over ${checked} samples is lawful`, bad.length === 0, bad.join(' · '))
    const fx = clusters.reduce((s, c) => s + c.cx, 0) / clusters.length
    const descent: Array<[number | null, number | null]> = []
    for (let py = -8; py <= H + 8; py += 1) descent.push([fx + 0.3, py])
    descent.push([null, null])
    const d = walk(art, descent)
    t(`${def.name} ${label}: the descent walks adjacent offsets`, d.adjacent, d.detail)
    const restRow = clusters[0]!.rest.r
    const restColGaps = clusters.slice(1).map(cl => cl.rest.c - clusters[0]!.rest.c)
    const squareOpts = { square: true as const }
    const defForCompose = def
    const rest = composeCritterFrame(defForCompose, { ...squareOpts, pupil: '●', gazeKey: '', swayPhase: 0, sleepPhase: null })
    t(`${def.name} ${label}: the rest frame is the authored grid (whole render, no slice)`, rest.art.join('\n') === art.join('\n'))
    const fbad: string[] = []
    for (let sway = 0; sway < 8; sway++) {
      const open = composeCritterFrame(defForCompose, { ...squareOpts, pupil: '●', gazeKey: '', swayPhase: sway, sleepPhase: null })
      if (open.art.join('\n') !== rest.art.join('\n') && fbad.length < 4) fbad.push(`sway=${sway} moved a still body`)
      const lid = composeCritterFrame(defForCompose, { ...squareOpts, pupil: '—', gazeKey: '', swayPhase: sway, sleepPhase: null })
      if (pupilsOf(lid.art).length !== 0 && fbad.length < 4) fbad.push(`sway=${sway}: pupils on a lid frame`)
    }
    for (const o of shared) {
      const key = clusters.map(cl => `${cl.rest.r},${cl.rest.c}>${cl.rest.r + o.dr},${cl.rest.c + o.dc}`).join('|')
      const gazed = composeCritterFrame(defForCompose, { ...squareOpts, pupil: '●', gazeKey: key, swayPhase: 0, sleepPhase: null })
      const ks = pupilsOf(gazed.art).sort((a, b) => a.c - b.c)
      const rowOk = ks.length === clusters.length && ks.every(k => k.r === restRow + o.dr)
      const gapOk = ks.slice(1).every((k, i) => k.c - ks[0]!.c === restColGaps[i])
      if ((!rowOk || !gapOk) && fbad.length < 4) fbad.push(`key ${key.slice(0, 12)}: pupils ${ks.map(k => `${k.r},${k.c}`).join(' ')}`)
    }
    t(`${def.name} ${label}: composed square frames all lawful (still · lidded whole · rigid gaze)`, fbad.length === 0, fbad.join(' · '))
  }
}


console.log('— §B highlight bands: anatomy is registered, the octopus is uniform —')

function bandRowsOf(art: readonly string[]): number[] {
  const rows: number[] = []
  for (let r = 0; r < art.length; r++) {
    if (/[L%]{4,}/.test(art[r]!)) rows.push(r)
  }
  return rows
}

type BandEntry = { reason: string; rows: readonly number[] }
const BAND_ANATOMY: Readonly<Record<string, BandEntry>> = {
  'crab · 13w awake': { reason: "the crab's belly band", rows: [8, 9] },
  'crab · 13w sleep': { reason: 'the belly band between the tucked claws', rows: [10] },
  'crab · mini sleep': { reason: 'the belly band between the tucked claws', rows: [4] },
  'jellyfish · 13w awake': { reason: "the jellyfish's lit skirt rim", rows: [6] },
  'jellyfish · mini awake': { reason: "the jellyfish's lit skirt rim", rows: [4] },
  'jellyfish · 13w sleep': { reason: 'the skirt rim on the sunken bell', rows: [7] },
  'jellyfish · mini sleep': { reason: 'the skirt rim on the sunken bell', rows: [4] },
  'clam · 13w awake': { reason: "the clam's mantle band along the opening", rows: [6] },
  'clam · mini awake': { reason: "the clam's mantle band along the opening", rows: [4] },
  'jellyfish · square dock': { reason: "the jellyfish's lit skirt rim (the square dock)", rows: [4] },
  'clam · square dock': { reason: "the clam's mantle band along the opening (the square dock)", rows: [4] },
}

const gridRoster: Array<[string, string[] | null]> = []
for (const def of CRITTERS) {
  const name = def.name
  gridRoster.push([`${name} · 13w awake`, def.art])
  gridRoster.push([`${name} · mini awake`, miniArtFor(name)])
  gridRoster.push([`${name} · square dock`, def.squareDock])
  for (const form of ['art', 'mini'] as ArtForm[]) {
    const pose = sleepPoseFor({ name }, form)
    if (pose) gridRoster.push([`${name} · ${form === 'art' ? '13w' : form} sleep`, pose.art])
  }
}

console.log('  the sweep table (grid · band rows found · registry verdict):')
for (const [label, art] of gridRoster) {
  if (!art) continue
  const found = bandRowsOf(art)
  const reg = BAND_ANATOMY[label]
  const regRows = new Set(reg?.rows ?? [])
  const unregistered = found.filter(r => !regRows.has(r))
  const stale = [...regRows].filter(r => !found.includes(r))
  console.log(
    `  · ${label}: bands [${found.join(',') || 'none'}]${reg ? ` · registered [${reg.rows.join(',')}] — ${reg.reason}` : ' · registers nothing'}`,
  )
  t(`${label}: every band row is registered anatomy`, unregistered.length === 0, `unregistered rows ${unregistered.join(',')}: ${unregistered.map(r => JSON.stringify(art[r])).join(' ')}`)
  t(`${label}: no stale band registration`, stale.length === 0, `rows ${stale.join(',')} carry no band — prune them`)
}
t('the octopus registers NO band on any grid (uniform body — the ruling)', Object.keys(BAND_ANATOMY).every(k => !k.startsWith('octopus')))
t('every registry key names a grid the sweep walked', Object.keys(BAND_ANATOMY).every(k => gridRoster.some(([label]) => label === k)), Object.keys(BAND_ANATOMY).filter(k => !gridRoster.some(([label]) => label === k)).join(' · '))


console.log('— poison: the retired per-eye sampler trips the law —')
function perEyeReferenceKey(art: readonly string[], px: number, py: number): string {
  const moves: string[] = []
  for (const eye of heroEyeClusters(art) as Cluster[]) {
    const vx = px - eye.cx
    const vy = py - eye.cy
    const dist = Math.hypot(vx, vy)
    if (dist < GAZE_DEAD_ZONE) continue
    const ux = vx / dist
    const uy = vy / dist
    let best: Cell | null = null
    let bestScore = 0
    for (const cell of eye.cells) {
      const ox = cell.c - eye.rest.c
      const oy = cell.r - eye.rest.r
      if (ox === 0 && oy === 0) continue
      const proj = (ox * ux + oy * uy) / Math.hypot(ox, oy)
      if (proj < GAZE_MIN_COS) continue
      if (best === null || proj > bestScore) {
        best = cell
        bestScore = proj
      }
    }
    if (best) moves.push(`${eye.rest.r},${eye.rest.c}>${best.r},${best.c}`)
  }
  return moves.join('|')
}

{
  const octo = POOL.find(d => d.name === 'octopus')!.squareDock
  const octoClusters = heroEyeClusters(octo) as Cluster[]
  let desync: string | null = null
  for (let py = -8; py <= octo.length + 8 && !desync; py++) {
    for (let px = -8; px <= 32 && !desync; px++) {
      const key = perEyeReferenceKey(octo, px, py)
      if (key && gazeKeyViolations(octo, octoClusters, key).length > 0) desync = `@(${px},${py}) ${key}`
    }
  }
  t('poison: the per-eye sampler DESYNCS the octopus and the census catches it', desync !== null, desync ?? 'no desync found')
  const clam = POOL.find(d => d.name === 'clam')!.squareDock
  const clamClusters = heroEyeClusters(clam) as Cluster[]
  let split: string | null = null
  for (let py = -8; py <= clam.length + 8 && !split; py++) {
    for (let px = -8; px <= 32 && !split; px++) {
      const key = perEyeReferenceKey(clam, px, py)
      if (!key) continue
      const v = gazeKeyViolations(clam, clamClusters, key)
      if (v.some(x => x.includes('split'))) split = `@(${px},${py}) ${key}`
    }
  }
  t('poison: the per-eye sampler SPLITS the clam pupil rows (the wrap) and the census catches it', split !== null, split ?? 'no split found')
  let hop = false
  let last: Offset = { dr: 0, dc: 0 }
  for (const [px, py] of [[-12, 9], [32, -12], [-12, 9], [32, 24]] as Array<[number, number]>) {
    const o = offsetOfKey(gazeKeyForPointer(octo, px, py, ''))
    const now = o === null || o === 'MIXED' ? { dr: 0, dc: 0 } : o
    if (chebyshev(last, now) > 1) hop = true
    last = now
  }
  t('poison: discarding the fed-forward key full-throws the pupil (adjacency walker bites)', hop)
}

console.log('— poison: the band detectors bite —')
{
  const STRIPED = ['..MMMMMM..', '..LLLLLL..', '..MMMMMM..']
  t('poison: an unregistered 4-run stripe is detected', bandRowsOf(STRIPED).length === 1 && bandRowsOf(STRIPED)[0] === 1)
  const WEDGE = ['..LLLMMM..', '..MMMMMM..']
  t('poison: a ≤3 light-source wedge is NOT a band', bandRowsOf(WEDGE).length === 0)
  const UNIFORM = ['..MMMMMM..', '..MMMMMM..']
  t('poison: a registered row over a uniform grid reads STALE', bandRowsOf(UNIFORM).length === 0)
}

console.log(failures ? '\n❌ CRITTER-LOOK CENSUS RED' : '\n✅ CRITTER-LOOK CENSUS GREEN')
process.exit(failures)
