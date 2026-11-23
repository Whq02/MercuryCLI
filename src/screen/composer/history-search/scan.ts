import type React from 'react'
import { loadHistoryCorpus, makeHistoryReaderOver, type HistoryCorpus } from '../../../sessions/promptHistory.js'
import type { HistoryEntry } from '../../../platform/settings/config.js'

export type Reader = AsyncGenerator<HistoryEntry>

export function scanOf(
  {
    scanAbortRef,
    closeReader,
    seenRef,
    scanInFlightRef,
    scanEpochRef,
    corpusRef,
    corpusValueRef,
    readerRef,
    failedRef,
    force,
    matchRef,
    applyMatch,
  }: {
    scanAbortRef: React.MutableRefObject<AbortController | null>
    closeReader: () => void
    seenRef: React.MutableRefObject<Set<string>>
    scanInFlightRef: React.MutableRefObject<boolean>
    scanEpochRef: React.MutableRefObject<number>
    corpusRef: React.MutableRefObject<Promise<HistoryCorpus> | null>
    corpusValueRef: React.MutableRefObject<HistoryCorpus | null>
    readerRef: React.MutableRefObject<Reader | null>
    failedRef: React.MutableRefObject<boolean>
    force: () => void
    matchRef: React.MutableRefObject<HistoryEntry | undefined>
    applyMatch: (entry: HistoryEntry, query: string) => void
  },
  query: string,
  continueScan: boolean,
): void {
  scanAbortRef.current?.abort()
  const abort = new AbortController()
  scanAbortRef.current = abort
  if (!continueScan) {
    closeReader()
    seenRef.current.clear()
  }
  scanInFlightRef.current = true
  const token = ++scanEpochRef.current
  void (async () => {
    try {
      const corpus = await (corpusRef.current ??= loadHistoryCorpus())
      corpusValueRef.current = corpus
      if (abort.signal.aborted) return
      if (!continueScan || readerRef.current === null) readerRef.current = makeHistoryReaderOver(corpus)
      const reader = readerRef.current
      for (;;) {
        if (abort.signal.aborted) return
        const next = await reader.next()
        if (abort.signal.aborted) return
        if (next.done) {
          failedRef.current = true
          force()
          return
        }
        const entry = next.value
        if (!entry.display.includes(query)) continue
        if (seenRef.current.has(entry.display)) continue
        seenRef.current.add(entry.display)
        matchRef.current = entry
        failedRef.current = false
        applyMatch(entry, query)
        force()
        return
      }
    } finally {
      if (token === scanEpochRef.current) scanInFlightRef.current = false
    }
  })()
}
