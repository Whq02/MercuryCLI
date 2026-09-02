import { flagEnv } from '../../substrate/flagRegistry.js'
// ============================================================================
//  utils/cockpit/critterGaze — the hero mascot's mouse-tracking GAZE, as pure
//  React-free math (the critterIdle.ts doctrine: schedule/gates provable
//  without racing a live PTY).
//
//  The authored hero grids (critterData.ts) draw each eye as a cream E
//  cluster holding one K pupil. THE GAZE LAW (operator ruling —
//  the wall-eyed octopus and the clam's edge-wrapped pupil were both the
//  per-eye-sampling class):
//    (i)   ONE gaze source feeds every eye. The pointer is read against the
//          FACE — the mean of the eye centroids — and the one chosen offset
//          moves every pupil identically, so the eyes agree by construction
//          and can never be sampled apart.
//    (ii)  The offset CLAMPS inside the eye aperture: candidates are the
//          offsets EVERY eye can host (the intersection of the clusters'
//          cells around their rests), so a glance never wraps or splits a
//          pupil across opposite edges.
//    (iii) The sweep moves through ADJACENT offsets: each derived key steps
//          at most one cell (per axis) from the previous key toward the
//          target, so a full-throw pointer jump walks the pupils across the
//          eye instead of teleporting them.
//  Everything is letter swaps inside the authored clusters: the silhouette,
//  hues, light source and layout never change, and a neutral gaze is
//  BYTE-IDENTICAL to the authored art (the same OFF ⇒ identical contract the
//  blink keeps).
//
//  Hard invariants (the proof pins each — prove-critter-gaze, and the
//  per-frame census in prove-critter-look-census):
//    · neutral in ⇒ the SAME array reference out (React memo bails; captures
//      stay hermetic),
//    · a pupil never leaves its eye cluster, never crosses its half-block
//      row-pair (so heroBlinkRows' pair-row lid detection still covers it),
//    · K-count preserved — every eye keeps exactly one pupil,
//    · every eye carries the SAME offset in every key this module emits,
//    · consecutive keys (prev fed forward) are chebyshev-adjacent offsets,
//    · width-preserving (letter swaps only — heroContentBounds stable),
//    · a stale/foreign gaze key (critter switched mid-hover) REFUSES and
//      returns the authored art unchanged, never a corrupted grid.
//
//  Order of composition in the renderer: gaze FIRST, blink ON TOP — a lid
//  covers a moved pupil exactly like a resting one.
// ============================================================================


/** Pointer distance (in art pixels ≈ half-block cells) inside which the
 *  critter reads the pointer as "right here" and keeps its authored
 *  straight-ahead gaze — eyes that snap sideways when you touch the mascot
 *  read broken, not alive. Measured from the FACE anchor (one distance, one
 *  verdict): a per-eye dead zone let one eye rest while the other tracked,
 *  which is the disagreement class the gaze law forbids. */
export const GAZE_DEAD_ZONE = 3

/** Minimum direction agreement (cosine) before the face commits to an
 *  offset — below this no hostable offset actually points at the pointer,
 *  so the eyes stay at rest instead of picking a misleading corner. */
export const GAZE_MIN_COS = 0.55

/** Angle hysteresis: the face's CURRENT offset keeps the pupils unless a
 *  challenger beats its direction agreement by this cosine margin. With ~5
 *  shared offsets, a pointer drifting along a decision boundary otherwise
 *  flips the pupils cell-to-cell every event — jitter, not gaze. The margin
 *  is small enough that any deliberate pointer move still re-aims
 *  immediately (a ~7° swing clears it). */
export const GAZE_STICKY_COS = 0.08

export function critterGazeEnabled(): boolean {
  // Mirror critterIdleEnabled(): explicit "=0" hard-off, else stamp-gated.
  return flagEnv('MERCURY_CRITTER_GAZE') === '0' ? false : true
}

type Cell = { r: number; c: number }

type EyeCluster = {
  /** The authored pupil (rest) cell. */
  rest: Cell
  /** Every E/K cell of the eye, rest included. */
  cells: Cell[]
  /** Centroid in art coords (cell centers). */
  cx: number
  cy: number
}

/** A pupil displacement from its rest cell. {0,0} is the authored pose. */
type GazeOffset = { dr: number; dc: number }

const GAZE_REST: GazeOffset = { dr: 0, dc: 0 }

const isEyeChar = (ch: string | undefined): boolean => ch === 'E' || ch === 'K'

/** The clusters discovered per grid OBJECT. The view asks for the authored
 *  hero grid's clusters on every pointer cell the mascot could be looking
 *  at, and that grid is a module constant that is never mutated — so the
 *  scan runs once per grid and every later pointer event reads the same
 *  answer. Keyed weakly: a transient grid (a prover's transformed frame)
 *  takes its entry with it. Callers treat the clusters as read-only. */
const CLUSTERS_BY_GRID = new WeakMap<readonly string[], EyeCluster[]>()

/** Discover the eye clusters of a hero grid: for each authored K, the
 *  contiguous E/K column interval on its half-block row-pair. Pure scan —
 *  no diagonal leakage past a non-eye column, so a pair of wide-set eyes on
 *  one row stay two clusters. */
export function heroEyeClusters(art: readonly string[]): EyeCluster[] {
  const known = CLUSTERS_BY_GRID.get(art)
  if (known !== undefined) return known
  const clusters = scanEyeClusters(art)
  CLUSTERS_BY_GRID.set(art, clusters)
  return clusters
}

function scanEyeClusters(art: readonly string[]): EyeCluster[] {
  const clusters: EyeCluster[] = []
  const claimed = new Set<string>()
  for (let r = 0; r < art.length; r++) {
    const row = art[r]!
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== 'K' || claimed.has(`${r}:${c}`)) continue
      const top = r & ~1
      const rows = [top, top + 1].filter(rr => rr < art.length)
      // Expand the column interval from the pupil while EITHER pair row
      // carries an eye char.
      const eyeAt = (col: number): boolean =>
        rows.some(rr => isEyeChar(art[rr]?.[col]))
      let lo = c
      let hi = c
      while (lo - 1 >= 0 && eyeAt(lo - 1)) lo--
      while (eyeAt(hi + 1)) hi++
      const cells: Cell[] = []
      let sx = 0
      let sy = 0
      for (const rr of rows) {
        for (let cc = lo; cc <= hi; cc++) {
          if (!isEyeChar(art[rr]?.[cc])) continue
          cells.push({ r: rr, c: cc })
          sx += cc + 0.5
          sy += rr + 0.5
          if (art[rr]![cc] === 'K') claimed.add(`${rr}:${cc}`)
        }
      }
      if (cells.length === 0) continue
      clusters.push({
        rest: { r, c },
        cells,
        cx: sx / cells.length,
        cy: sy / cells.length,
      })
    }
  }
  return clusters
}

/** The offsets EVERY eye of the grid can host — the aperture intersection
 *  the gaze law clamps to (law ii). Discovered once per grid object, like
 *  the clusters. Every offset targets an authored cluster cell on the
 *  rest's own half-block row-pair, so applyGazeKey's validation accepts by
 *  construction. */
const SHARED_OFFSETS_BY_GRID = new WeakMap<readonly string[], GazeOffset[]>()

function sharedGazeOffsets(art: readonly string[]): GazeOffset[] {
  const known = SHARED_OFFSETS_BY_GRID.get(art)
  if (known !== undefined) return known
  const clusters = heroEyeClusters(art)
  const offsets: GazeOffset[] = []
  if (clusters.length > 0) {
    const hosts = (cl: EyeCluster, o: GazeOffset): boolean =>
      cl.cells.some(c => c.r === cl.rest.r + o.dr && c.c === cl.rest.c + o.dc)
    for (const cell of clusters[0]!.cells) {
      const o = { dr: cell.r - clusters[0]!.rest.r, dc: cell.c - clusters[0]!.rest.c }
      if (o.dr === 0 && o.dc === 0) continue
      if (clusters.every(cl => hosts(cl, o))) offsets.push(o)
    }
  }
  SHARED_OFFSETS_BY_GRID.set(art, offsets)
  return offsets
}

/** The offset a previously-emitted key carries against THIS grid's
 *  clusters, or rest. A foreign key (another critter's rests) or a
 *  disagreeing key matches nothing and reads as rest — it seeds no
 *  stickiness and no step origin, exactly the harmless degradation the
 *  apply side keeps. */
function offsetOfPrevKey(clusters: EyeCluster[], prevKey: string): GazeOffset {
  if (!prevKey) return GAZE_REST
  let found: GazeOffset | null = null
  for (const part of prevKey.split('|')) {
    const m = /^(\d+),(\d+)>(\d+),(\d+)$/.exec(part)
    if (!m) return GAZE_REST
    const from = { r: Number(m[1]), c: Number(m[2]) }
    const o = { dr: Number(m[3]) - from.r, dc: Number(m[4]) - from.c }
    if (!clusters.some(cl => cl.rest.r === from.r && cl.rest.c === from.c)) return GAZE_REST
    if (found === null) found = o
    else if (found.dr !== o.dr || found.dc !== o.dc) return GAZE_REST
  }
  return found ?? GAZE_REST
}

/** ONE step from `prev` toward `target`, clamped to the hostable offsets
 *  (law iii). Each axis moves at most one cell; a stepped offset no eye can
 *  host harbors at rest instead — adjacency-sound while every shared offset
 *  sits within one step of rest, which the census pins over the authored
 *  grids. */
function stepToward(prev: GazeOffset, target: GazeOffset, shared: GazeOffset[]): GazeOffset {
  const dr = prev.dr + Math.sign(target.dr - prev.dr)
  const dc = prev.dc + Math.sign(target.dc - prev.dc)
  if (dr === 0 && dc === 0) return GAZE_REST
  return shared.some(o => o.dr === dr && o.dc === dc) ? { dr, dc } : GAZE_REST
}

/** Decide the gaze for a pointer at (px, py) in ART coordinates (fractional
 *  fine; the view converts screen cells). Returns the compact MOVE key —
 *  `"kr,kc>tr,tc"` per pupil, `|`-joined, every move the SAME offset — or
 *  `''` for the authored rest pose (pointer null, in the dead zone, or no
 *  hostable offset points that way).
 *
 *  `prevKey` (the LAST key this view rendered) arms BOTH laws that read
 *  history: the face-level hysteresis (the current offset keeps the pupils
 *  unless a challenger beats it by GAZE_STICKY_COS — a pointer drifting
 *  along a decision boundary no longer jitters the pupils cell-to-cell) and
 *  the one-step walk (law iii). Omitting it keeps the pure stateless
 *  behavior: rest is one step from every offset the pool authors, so a
 *  stateless call still lands its target directly. */
export function gazeKeyForPointer(
  art: readonly string[],
  px: number | null,
  py: number | null,
  prevKey = '',
): string {
  const clusters = heroEyeClusters(art)
  if (clusters.length === 0) return ''
  const shared = sharedGazeOffsets(art)
  const prev = offsetOfPrevKey(clusters, prevKey)
  let target = GAZE_REST
  if (px != null && py != null && shared.length > 0) {
    // THE face anchor — the one gaze source (law i).
    const fx = clusters.reduce((s, cl) => s + cl.cx, 0) / clusters.length
    const fy = clusters.reduce((s, cl) => s + cl.cy, 0) / clusters.length
    const vx = px - fx
    const vy = py - fy
    const dist = Math.hypot(vx, vy)
    if (dist >= GAZE_DEAD_ZONE) {
      const ux = vx / dist
      const uy = vy / dist
      let best: GazeOffset | null = null
      let bestScore = 0
      let bestStrength = 0
      for (const o of shared) {
        const olen = Math.hypot(o.dc, o.dr)
        const proj = (o.dc * ux + o.dr * uy) / olen
        const isPrev = o.dr === prev.dr && o.dc === prev.dc
        // Hysteresis covers BOTH jitter classes: the current offset scores a
        // bonus against challengers (cell-to-cell flips) AND keeps a lowered
        // eligibility threshold (an engaged face no longer snaps to rest and
        // back as the pointer drifts along the cone edge).
        if (proj < (isPrev ? GAZE_MIN_COS - GAZE_STICKY_COS : GAZE_MIN_COS)) continue
        // Score = direction agreement + the hysteresis bonus; ties still
        // break toward the farther cell (the full swing reads clearly at
        // terminal scale).
        const score = proj + (isPrev ? GAZE_STICKY_COS : 0)
        const strength = o.dc * ux + o.dr * uy
        if (
          best === null ||
          score > bestScore + 1e-9 ||
          (Math.abs(score - bestScore) <= 1e-9 && strength > bestStrength)
        ) {
          best = o
          bestScore = score
          bestStrength = strength
        }
      }
      if (best !== null) target = best
    }
  }
  const next = stepToward(prev, target, shared)
  if (next.dr === 0 && next.dc === 0) return ''
  return clusters
    .map(cl => `${cl.rest.r},${cl.rest.c}>${cl.rest.r + next.dr},${cl.rest.c + next.dc}`)
    .join('|')
}

/** Apply a gaze key to a hero grid. VALIDATES every move against the grid it
 *  is applied to — source must be the K it claims, target must be an E on the
 *  same half-block row-pair — and refuses the WHOLE key (returns the same
 *  array reference) on any violation, so a key computed against one critter
 *  can never corrupt another's art. `''` is the identity. */
export function applyGazeKey(art: string[], key: string): string[] {
  if (!key) return art
  const moves: Array<{ from: Cell; to: Cell }> = []
  for (const part of key.split('|')) {
    const m = /^(\d+),(\d+)>(\d+),(\d+)$/.exec(part)
    if (!m) return art
    const from = { r: Number(m[1]), c: Number(m[2]) }
    const to = { r: Number(m[3]), c: Number(m[4]) }
    if (art[from.r]?.[from.c] !== 'K') return art
    if (art[to.r]?.[to.c] !== 'E') return art
    if ((from.r & ~1) !== (to.r & ~1)) return art
    moves.push({ from, to })
  }
  const rows = art.slice()
  const setChar = (r: number, c: number, ch: string): void => {
    rows[r] = rows[r]!.slice(0, c) + ch + rows[r]!.slice(c + 1)
  }
  for (const { from, to } of moves) {
    setChar(from.r, from.c, 'E')
    setChar(to.r, to.c, 'K')
  }
  return rows
}

/** Convenience composition for proofs and simple callers: pointer → rows. */
export function heroGazeRows(
  art: string[],
  px: number | null,
  py: number | null,
): string[] {
  return applyGazeKey(art, gazeKeyForPointer(art, px, py))
}
