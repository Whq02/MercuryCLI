import { flagEnv } from '../../substrate/flagRegistry.js'


export const GAZE_DEAD_ZONE = 3

export const GAZE_MIN_COS = 0.55

export const GAZE_STICKY_COS = 0.08

export function critterGazeEnabled(): boolean {
  return flagEnv('MERCURY_CRITTER_GAZE') === '0' ? false : true
}

type Cell = { r: number; c: number }

type EyeCluster = {
  rest: Cell
  cells: Cell[]
  cx: number
  cy: number
}

type GazeOffset = { dr: number; dc: number }

const GAZE_REST: GazeOffset = { dr: 0, dc: 0 }

const isEyeChar = (ch: string | undefined): boolean => ch === 'E' || ch === 'K'

const CLUSTERS_BY_GRID = new WeakMap<readonly string[], EyeCluster[]>()

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

function stepToward(prev: GazeOffset, target: GazeOffset, shared: GazeOffset[]): GazeOffset {
  const dr = prev.dr + Math.sign(target.dr - prev.dr)
  const dc = prev.dc + Math.sign(target.dc - prev.dc)
  if (dr === 0 && dc === 0) return GAZE_REST
  return shared.some(o => o.dr === dr && o.dc === dc) ? { dr, dc } : GAZE_REST
}

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
        if (proj < (isPrev ? GAZE_MIN_COS - GAZE_STICKY_COS : GAZE_MIN_COS)) continue
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

export function heroGazeRows(
  art: string[],
  px: number | null,
  py: number | null,
): string[] {
  return applyGazeKey(art, gazeKeyForPointer(art, px, py))
}
