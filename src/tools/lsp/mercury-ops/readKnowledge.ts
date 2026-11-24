import { realpathSync } from 'node:fs'
import { checkSeenLines, fileGeneration } from '../../engines/change-transaction/seenLines.js'
import { type NormalizedFileEdits } from '../../../integrations/lsp/workspaceEditApply.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import { getCheckedFileModificationTime } from '../../../platform/files/file.js'
import { MAX_LINES_TO_READ } from '../../kit/names/read.js'
import type { OpEnv } from './types.js'
import { passedOver } from '../../../platform/errors/passedOver.js'

type ReadCache = {
  get: (path: string) => { content: string; timestamp: number; offset: number | undefined; limit: number | undefined; isPartialView?: boolean } | undefined
  entries?: () => IterableIterator<[string, { content: string; timestamp: number; offset: number | undefined; limit: number | undefined; isPartialView?: boolean }]>
}

function readEntryFor(cache: ReadCache | undefined, abs: string): ReturnType<ReadCache['get']> {
  if (!cache) return undefined
  const direct = cache.get(abs)
  if (direct) return direct
  let real: string
  try {
    real = realpathSync(abs)
  } catch (error) {
    passedOver(error)
    return undefined
  }
  if (real !== abs) {
    const viaReal = cache.get(real)
    if (viaReal) return viaReal
  }
  if (typeof cache.entries !== 'function') return undefined
  let scanned = 0
  for (const [key, entry] of cache.entries()) {
    if (++scanned > 512) break
    try {
      if (realpathSync(key) === real) return entry
    } catch (error) {
      passedOver(error)
      continue
    }
  }
  return undefined
}

const lineFeeds = (text: string): string => text.replaceAll('\r\n', '\n')

export function readKnowledgeHolds(
  env: OpEnv,
  abs: string,
  snapshot: string,
  touched: Array<{ start: number; end: number }>,
): boolean {
  const entry = readEntryFor(env.context.readFileState, abs)
  if (entry && entry.isPartialView !== true) {
    const full = (entry.offset === undefined || entry.offset === 0) && entry.limit === undefined
    if (full) {
      if (lineFeeds(entry.content) === lineFeeds(snapshot)) return true
    } else {
      const start = Math.max(1, entry.offset ?? 1)
      const count = Math.min(entry.limit ?? MAX_LINES_TO_READ, entry.content.split('\n').length)
      const covers = touched.every(range => range.start >= start && range.end < start + count)
      if (covers && getCheckedFileModificationTime(abs) <= entry.timestamp) return true
    }
  }
  try {
    const generation = fileGeneration(abs)
    if (generation !== null) {
      const seen = checkSeenLines(
        ownerFromToolUseContext(env.context),
        abs,
        generation,
        touched.map((range, index) => ({ index: index + 1, start: range.start, end: range.end, replace: '' })),
      )
      if (seen.ok) return true
    }
  } catch (error) {
    passedOver(error)
    return false
  }
  return false
}

export function touchedLinesOf(file: NormalizedFileEdits): Array<{ start: number; end: number }> {
  return file.edits.map(edit => ({ start: edit.range.start.line + 1, end: edit.range.end.line + 1 }))
}
