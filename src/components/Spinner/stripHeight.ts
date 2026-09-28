export type StripHeightLatch = { epoch: number; lines: number }

export function stripLinesForEpoch(latch: StripHeightLatch, epoch: number, wanted: number): number {
  const lines = Math.max(1, Math.floor(wanted))
  if (latch.epoch !== epoch) {
    latch.epoch = epoch
    latch.lines = lines
    return lines
  }
  if (lines > latch.lines) latch.lines = lines
  return latch.lines
}

const turnLatch: StripHeightLatch = { epoch: 0, lines: 1 }

export function turnStripLines(epoch: number, wanted: number): number {
  return stripLinesForEpoch(turnLatch, epoch, wanted)
}
