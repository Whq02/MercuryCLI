import { useMemo, useRef, useState } from 'react'
import { useLoad } from '../effects/effects.js'
import type { StructuredPatchHunk } from '../../platform/text/diff.js'
import {
  fetchGitDiff,
  fetchGitDiffFor,
  fetchGitDiffHunks,
  fetchGitDiffHunksFor,
  type GitDiffResult,
  type GitDiffSpec,
  type GitDiffStats,
} from './gitDiff.js'
import { logError } from '../../platform/logs/errorLog.js'

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
  error?: string
}

function classify(
  result: GitDiffResult,
  hunks: Map<string, StructuredPatchHunk[]>,
): DiffFile[] {
  const files: DiffFile[] = []
  for (const [path, fileStats] of result.perFileStats.entries()) {
    const fileHunks = hunks.get(path)
    const isUntracked = fileStats.isUntracked === true
    const isBinary = fileStats.isBinary
    const isLargeFile = !isUntracked && !isBinary && (!fileHunks || fileHunks.length === 0)
    const isTruncated =
      !isLargeFile &&
      !isBinary &&
      fileStats.linesAdded + fileStats.linesRemoved > TRUNCATION_LINE_LIMIT
    files.push({
      path,
      linesAdded: fileStats.linesAdded,
      linesRemoved: fileStats.linesRemoved,
      isBinary,
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
  const specKey = useMemo(() => (spec ? JSON.stringify(spec) : ''), [spec])
  const specRef = useRef(spec)
  specRef.current = spec

  useLoad(signal => {
    const activeSpec = specRef.current
    setData(prev => ({
      stats: prev.stats,
      files: prev.files,
      hunks: prev.hunks,
      loading: true,
    }))
    const statsPromise = activeSpec ? fetchGitDiffFor(activeSpec) : fetchGitDiff()
    const hunksPromise = activeSpec ? fetchGitDiffHunksFor(activeSpec) : fetchGitDiffHunks()
    void Promise.all([statsPromise, hunksPromise])
      .then(([result, hunks]) => {
        if (signal.aborted) return
        if (result === null) {
          setData({
            stats: null,
            files: [],
            hunks: new Map(),
            loading: false,
          })
          return
        }
        setData({
          stats: result.stats,
          files: classify(result, hunks),
          hunks,
          loading: false,
        })
      })
      .catch((err: unknown) => {
        logError(err)
        if (signal.aborted) return
        setData({
          stats: null,
          files: [],
          hunks: new Map(),
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, [specKey])

  return data
}
