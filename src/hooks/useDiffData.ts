// Diff data for a comparison: statistics and hunks fetched in
// PARALLEL through the same parameterised fetchers for every comparison
// kind (no spec = working tree vs head). Refetch keys on the spec's
// SERIALISED identity so a same-shape re-render does not refetch. Failures
// reset to null result, empty hunks, not-loading; in-flight results are
// dropped after unmount or a spec change.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { StructuredPatchHunk } from '../utils/diff.js'
import {
  fetchGitDiff,
  fetchGitDiffFor,
  fetchGitDiffHunks,
  fetchGitDiffHunksFor,
  type GitDiffResult,
  type GitDiffSpec,
  type GitDiffStats,
} from '../utils/gitDiff.js'
import { logError } from '../utils/log.js'

const TRUNCATION_LINE_LIMIT = 400

export type DiffFile = {
  path: string
  linesAdded: number
  linesRemoved: number
  isBinary: boolean
  isLargeFile: boolean
  isTruncated: boolean
  isUntracked?: boolean
  isNewFile?: boolean
}

export type DiffData = {
  stats: GitDiffStats | null
  files: DiffFile[]
  hunks: Map<string, StructuredPatchHunk[]>
  loading: boolean
}

function classify(
  result: GitDiffResult,
  hunks: Map<string, StructuredPatchHunk[]>,
): DiffFile[] {
  const files: DiffFile[] = []
  for (const [path, stats] of result.perFileStats) {
    const isUntracked = stats.isUntracked === true
    const fileHunks = hunks.get(path)
    // Large: present in the statistics but skipped by the hunk fetch.
    const isLargeFile =
      !stats.isBinary && !isUntracked && (fileHunks === undefined || fileHunks.length === 0)
    const isTruncated =
      !isLargeFile &&
      !stats.isBinary &&
      stats.added + stats.removed > TRUNCATION_LINE_LIMIT
    files.push({
      path,
      linesAdded: stats.added,
      linesRemoved: stats.removed,
      isBinary: stats.isBinary,
      isLargeFile,
      isTruncated,
      isUntracked,
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

export function useDiffData(spec?: GitDiffSpec): DiffData {
  const [data, setData] = useState<DiffData>({
    stats: null,
    files: [],
    hunks: new Map(),
    loading: true,
  })
  // Refetch keys on the serialised identity, not object identity.
  const specKey = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec])
  const specRef = useRef(spec)
  specRef.current = spec

  useEffect(() => {
    let dropped = false
    setData(prev => ({ ...prev, loading: true }))
    void (async () => {
      try {
        const currentSpec = specRef.current
        const [result, hunks] = await Promise.all([
          currentSpec ? fetchGitDiffFor(currentSpec) : fetchGitDiff(),
          currentSpec ? fetchGitDiffHunksFor(currentSpec) : fetchGitDiffHunks(),
        ])
        if (dropped) return
        if (result === null) {
          setData({ stats: null, files: [], hunks: new Map(), loading: false })
          return
        }
        setData({
          stats: result.stats,
          files: classify(result, hunks),
          hunks,
          loading: false,
        })
      } catch (error) {
        logError(error)
        if (dropped) return
        setData({ stats: null, files: [], hunks: new Map(), loading: false })
      }
    })()
    return () => {
      dropped = true
    }
  }, [specKey])

  return data
}
