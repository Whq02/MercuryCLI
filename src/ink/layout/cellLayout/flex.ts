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
  const settled = line.map(item => (free >= 0 ? item.node.flexGrow : item.node.flexShrink) === 0)
  line.forEach((item, at) => {
    item.targetMain = settled[at] ? clamped(item.node, item.basis) : item.basis
  })
  for (let round = 0; round <= line.length && settled.includes(false); round++) {
    let growSum = 0
    let shrinkWeight = 0
    let shrinkSum = 0
    let moved = 0
    line.forEach((item, at) => {
      if (settled[at]) {
        moved += item.targetMain - item.basis
      } else {
        growSum += item.node.flexGrow
        shrinkWeight += item.node.flexShrink * item.basis
        shrinkSum += item.node.flexShrink
      }
    })
    let left = free - moved
    if (left > 0 && growSum > 0 && growSum < 1) left = Math.min(left, free * growSum)
    else if (left < 0 && shrinkWeight > 0 && shrinkSum < 1) left = Math.max(left, free * shrinkSum)
    const wanted = line.map((item, at) => {
      if (settled[at]) return item.targetMain
      if (left > 0 && growSum > 0) return item.basis + (left * item.node.flexGrow) / growSum
      if (left < 0 && shrinkWeight > 0) return item.basis + (left * (item.node.flexShrink * item.basis)) / shrinkWeight
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
