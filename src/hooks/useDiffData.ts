import { useMemo, useRef, useState } from 'react'
import { useLoad } from './effects.js'
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
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const TRUNCATION_LINE_LIMIT = 400

export type DiffFile = Unbuilt

export type DiffData = Unbuilt

function classify(
  result: GitDiffResult,
  hunks: Map<string, StructuredPatchHunk[]>,
): DiffFile[] {
  return notBuilt('src/hooks/useDiffData.ts:37')
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

  useLoad(() => {
    let dropped = false
    setData(prev => ({ stats: prev.stats, files: prev.files, hunks: prev.hunks, loading: true }))
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
        setData({
          stats: null,
          files: [],
          hunks: new Map(),
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    return () => {
      dropped = true
    }
  }, [specKey])

  return data
}
