type Flexible = { flexGrow: number; flexShrink: number }

export function resolveFlexibleLengths<N extends Flexible>(
  line: Array<{ node: N; basis: number; targetMain: number }>,
  flexAvail: number | undefined,
  lineBasis: number,
  clampMain: (c: N, v: number) => number,
): void {
  const clamped = (node: N, size: number): number => Math.max(0, clampMain(node, size))
  if (flexAvail === undefined) {
    for (const item of line) item.targetMain = clamped(item.node, item.basis)
    return
  }
  const free = flexAvail - lineBasis
  const growing = free >= 0
  const settled = line.map(item => (growing ? item.node.flexGrow : item.node.flexShrink) === 0)
  line.forEach((item, at) => {
    item.targetMain = settled[at] ? clamped(item.node, item.basis) : item.basis
  })
  for (let round = 0; round <= line.length && settled.includes(false); round++) {
    let moved = 0
    let factors = 0
    let weights = 0
    line.forEach((item, at) => {
      if (settled[at]) {
        moved += item.targetMain - item.basis
      } else {
        factors += growing ? item.node.flexGrow : item.node.flexShrink
        weights += item.node.flexShrink * item.basis
      }
    })
    let left = free - moved
    if (growing && factors > 0 && factors < 1) left = Math.min(left, free * factors)
    if (!growing && factors < 1) left = Math.max(left, free * factors)
    const grows = growing && left > 0 && factors > 0
    const shrinks = !growing && left < 0 && weights > 0
    const wanted = line.map((item, at) => {
      if (settled[at]) return item.targetMain
      if (grows) return item.basis + (left * item.node.flexGrow) / factors
      if (shrinks) return item.basis + (left * (item.node.flexShrink * item.basis)) / weights
      return item.basis
    })
    let difference = 0
    line.forEach((item, at) => {
      if (settled[at]) return
      item.targetMain = clamped(item.node, wanted[at]!)
      difference += item.targetMain - wanted[at]!
    })
    if (difference === 0) return
    let settledNow = false
    line.forEach((item, at) => {
      if (settled[at]) return
      if (difference > 0 ? item.targetMain > wanted[at]! : item.targetMain < wanted[at]!) {
        settled[at] = true
        settledNow = true
      }
    })
    if (!settledNow) return
  }
}
