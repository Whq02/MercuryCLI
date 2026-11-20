type Flexible = { flexGrow: number; flexShrink: number }

export function resolveFlexibleLengths<N extends Flexible>(
  line: Array<{ node: N; basis: number; targetMain: number }>,
  flexAvail: number | undefined,
  lineBasis: number,
  clampMain: (c: N, v: number) => number,
): void {
  const n = line.length
  const frozen: boolean[] = new Array(n).fill(false)
  const initialFree = flexAvail !== undefined ? flexAvail - lineBasis : 0
  for (let i = 0; i < n; i++) {
    const item = line[i]!
    const inflexible =
      flexAvail === undefined ||
      (initialFree >= 0 ? item.node.flexGrow === 0 : item.node.flexShrink === 0)
    if (inflexible) {
      item.targetMain = Math.max(0, clampMain(item.node, item.basis))
      frozen[i] = true
    } else {
      item.targetMain = item.basis
    }
  }
  const unclamped: number[] = new Array(n)
  for (let iter = 0; iter <= n; iter++) {
    let frozenDelta = 0
    let totalGrow = 0
    let totalShrinkScaled = 0
    let unfrozenCount = 0
    for (let i = 0; i < n; i++) {
      const item = line[i]!
      if (frozen[i]) {
        frozenDelta += item.targetMain - item.basis
      } else {
        totalGrow += item.node.flexGrow
        totalShrinkScaled += item.node.flexShrink * item.basis
        unfrozenCount++
      }
    }
    if (unfrozenCount === 0) break
    let remaining = initialFree - frozenDelta
    if (remaining > 0 && totalGrow > 0 && totalGrow < 1) {
      const scaled = initialFree * totalGrow
      if (scaled < remaining) remaining = scaled
    } else if (remaining < 0 && totalShrinkScaled > 0) {
      let totalShrink = 0
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) totalShrink += line[i]!.node.flexShrink
      }
      if (totalShrink < 1) {
        const scaled = initialFree * totalShrink
        if (scaled > remaining) remaining = scaled
      }
    }
    let totalViolation = 0
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue
      const item = line[i]!
      let t = item.basis
      if (remaining > 0 && totalGrow > 0) {
        t += (remaining * item.node.flexGrow) / totalGrow
      } else if (remaining < 0 && totalShrinkScaled > 0) {
        t += (remaining * (item.node.flexShrink * item.basis)) / totalShrinkScaled
      }
      unclamped[i] = t
      const clamped = Math.max(0, clampMain(item.node, t))
      item.targetMain = clamped
      totalViolation += clamped - t
    }
    if (totalViolation === 0) break
    let anyFrozen = false
    for (let i = 0; i < n; i++) {
      if (frozen[i]) continue
      const v = line[i]!.targetMain - unclamped[i]!
      if ((totalViolation > 0 && v > 0) || (totalViolation < 0 && v < 0)) {
        frozen[i] = true
        anyFrozen = true
      }
    }
    if (!anyFrozen) break
  }
}
