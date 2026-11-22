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

export function useDiffData(spec?: GitDiffSpec): DiffData {
  return notBuilt('src/hooks/useDiffData.ts:65')
}
