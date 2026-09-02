/**
 * Self-write echo suppression, shared between the settings writer and the
 * change watcher: the writer marks a path just before touching disk, and
 * the watcher consumes the mark so its own echo does not fan out.
 */

const internalWriteMarks = new Map<string, number>()

export function markInternalWrite(path: string): void {
  internalWriteMarks.set(path, Date.now())
}

/**
 * True (and CONSUMES the mark) when the path was marked within the window.
 * Deleting on match matters: the watcher fires once per write, so a
 * matched mark must not also suppress the next, genuinely external change
 * to the same file.
 */
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
