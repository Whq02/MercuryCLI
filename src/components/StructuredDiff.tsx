
import React from 'react'
import { Box, RawAnsi } from '../ink.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import { useSettings } from '../hooks/useSettings.js'
import type { StructuredPatchHunk } from '../utils/diff.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { logError } from '../utils/log.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { expectColorDiff } from './StructuredDiff/colorDiff.js'
import { StructuredDiffFallback } from './StructuredDiff/Fallback.js'
import { boundPatchForRender, DIFF_LINE_RENDER_CAP } from './StructuredDiff/lineBudget.js'
import { useTheme } from './design-system/ThemeProvider.js'

type CacheEntry = {
  lines: string[]
  gutters: string[] | null
  contents: string[] | null
  gutterWidth: number
}

const hunkCache = new WeakMap<StructuredPatchHunk, Map<string, CacheEntry>>()
const HUNK_CACHE_LIMIT = 4

function gutterWidthOf(patch: StructuredPatchHunk): number {
  const maxLine = Math.max(
    1,
    patch.oldStart + patch.oldLines,
    patch.newStart + patch.newLines,
  )
  return String(maxLine).length + 3
}

function renderHighlighted(
  patch: StructuredPatchHunk,
  themeName: string,
  width: number,
  dim: boolean,
  filePath: string,
  firstLine: string | null,
  splitGutter: boolean,
): CacheEntry | null {
  const gutterWidth = splitGutter ? gutterWidthOf(patch) : 0
  const key = [themeName, width, dim, gutterWidth, firstLine ?? '', filePath].join(
    '\u0000',
  )
  let perHunk = hunkCache.get(patch)
  if (perHunk) {
    const cached = perHunk.get(key)
    if (cached) return cached
  }

  const ColorDiff = expectColorDiff()
  if (!ColorDiff) return null
  let lines: string[] | null = null
  try {
    const instance = new ColorDiff(patch, firstLine !== null && firstLine !== '' ? firstLine : null, filePath)
    if (typeof instance.render !== 'function') return null
    lines = instance.render(themeName, width, dim)
  } catch (error) {
    logError(error)
    return null
  }
  if (!lines) return null

  const doSplit = splitGutter && gutterWidth > 0 && gutterWidth < width
  const entry: CacheEntry = doSplit
    ? {
        lines,
        gutters: lines.map(line => sliceAnsi(line, 0, gutterWidth)),
        contents: lines.map(line => sliceAnsi(line, gutterWidth)),
        gutterWidth,
      }
    : { lines, gutters: null, contents: null, gutterWidth: 0 }

  if (!perHunk) {
    perHunk = new Map()
    hunkCache.set(patch, perHunk)
  }
  if (perHunk.size >= HUNK_CACHE_LIMIT) perHunk.clear()
  perHunk.set(key, entry)
  return entry
}

function DiffLine({
  entry,
  width,
}: {
  entry: CacheEntry
  width: number
}): React.ReactNode {
  if (entry.gutters === null || entry.contents === null) {
    return <RawAnsi lines={entry.lines} width={width} />
  }
  return (
    <Box>
      <NoSelect>
        <RawAnsi lines={entry.gutters} width={entry.gutterWidth} />
      </NoSelect>
      <RawAnsi lines={entry.contents} width={width - entry.gutterWidth} />
    </Box>
  )
}

export type StructuredDiffProps = {
  patch: StructuredPatchHunk
  dim: boolean
  filePath: string
  firstLine: string | null
  fileContent?: string
  width: number
  skipHighlighting?: boolean
}

export const StructuredDiff = React.memo(function StructuredDiff({
  patch,
  dim,
  filePath,
  firstLine,
  width,
  skipHighlighting = false,
}: StructuredDiffProps): React.ReactNode {
  const [themeName] = useTheme()
  const settings = useSettings()
  const renderWidth = Math.max(1, Math.floor(width))
  const highlightingOff =
    skipHighlighting || Boolean(settings.syntaxHighlightingDisabled)

  const bounded = boundPatchForRender(patch)
  const boundedFirstLine =
    firstLine !== null && firstLine.length > DIFF_LINE_RENDER_CAP
      ? firstLine.slice(0, DIFF_LINE_RENDER_CAP)
      : firstLine

  const entry = highlightingOff
    ? null
    : renderHighlighted(
        bounded,
        themeName,
        renderWidth,
        dim,
        filePath,
        boundedFirstLine,
        isFullscreenEnvEnabled(),
      )

  if (!entry) {
    return (
      <StructuredDiffFallback patch={bounded} dim={dim} width={renderWidth} />
    )
  }

  return <DiffLine entry={entry} width={renderWidth} />
})

export default StructuredDiff
