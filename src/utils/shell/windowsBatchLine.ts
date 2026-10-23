
const PERCENT_RUN = /%+[^%*?]*%+/g
const TRAILING_BACKSLASHES = /\\+$/

function quotedSegment(segment: string): string {
  return '"' + segment.replace(TRAILING_BACKSLASHES, run => run + run) + '"'
}

function barePercentRun(run: string): string {
  return run.replace(/^(%+)/, '$1^')
}

export function windowsBatchTail(words: readonly string[]): string | null {
  const emitted: string[] = []
  for (const word of words) {
    if (word.includes('"')) return null
    if (!word.includes('%')) {
      emitted.push(quotedSegment(word))
      continue
    }
    const runs = [...word.matchAll(PERCENT_RUN)]
    if (runs.length === 0) {
      emitted.push(quotedSegment(word))
      continue
    }
    if (runs.length > 1) return null
    const run = runs[0]!
    const start = run.index ?? 0
    const head = word.slice(0, start)
    const tail = word.slice(start + run[0].length)
    if (/^%+$/.test(run[0])) {
      if (head === '' && tail === '') return null
      emitted.push(quotedSegment(word))
      continue
    }
    if (head.includes('%') || tail.includes('%')) return null
    let piece = ''
    if (head !== '') piece += quotedSegment(head)
    piece += barePercentRun(run[0])
    if (tail !== '') piece += quotedSegment(tail)
    emitted.push(piece)
  }
  return '"' + emitted.join(' ') + '"'
}
