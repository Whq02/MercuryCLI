
const internalWriteMarks = new Map<string, number>()

export function markInternalWrite(path: string): void {
  internalWriteMarks.set(path, Date.now())
}

export function consumeInternalWrite(path: string, windowMs: number): boolean {
  const markedAt = internalWriteMarks.get(path)
  if (markedAt === undefined) return false
  if (Date.now() - markedAt > windowMs) return false
  internalWriteMarks.delete(path)
  return true
}

export function clearInternalWrites(): void {
  internalWriteMarks.clear()
}
