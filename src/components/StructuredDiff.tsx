import React from 'react'
import { Box, RawAnsi } from '../ink.js'
import { colorStripped } from '../ink/colorize.js'
import { NoSelect } from '../ink/components/NoSelect.js'
import { useSettings } from '../hooks/useSettings.js'
import type { StructuredPatchHunk } from '../utils/diff.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { logError } from '../utils/log.js'
import sliceAnsi from '../utils/sliceAnsi.js'
import { expectColorDiff } from './StructuredDiff/colorDiff.js'
import { StructuredDiffFallback } from './StructuredDiff/Fallback.js'
import { boundPatchForRender, DIFF_LINE_RENDER_CAP } from './StructuredDiff/lineBudget.js'
import { expandPatchTabs } from './StructuredDiff/tabExpansion.js'
import { useTheme } from './design-system/ThemeProvider.js'

type CacheEntry = {
  lines: string[]
  gutters: string[] | null
  contents: string[] | null
  gutterWidth: number
}

type StructuredDiffProps = {
  patch: StructuredPatchHunk
  dim: boolean
  width: number
  filePath?: string
  firstLine?: string | null
  fileContent?: string
  skipHighlighting?: boolean
}

const hunkCache = new WeakMap<StructuredPatchHunk, Map<string, CacheEntry>>()
const HUNK_CACHE_LIMIT = 4

function gutterWidthOf(patch: StructuredPatchHunk): number {
  const maxLine = Math.max(
    1,
    patch.oldStart + patch.oldLines - 1,
    patch.newStart + patch.newLines - 1,
  )
  return String(maxLine).length + 3
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

function renderNativeDiff(
  patch: StructuredPatchHunk,
  bounded: StructuredPatchHunk,
  themeName: string,
  renderWidth: number,
  dim: boolean,
  filePath: string | undefined,
  normalizedFirstLine: string | undefined,
  fileContent: string | undefined,
): CacheEntry | null {
  const splitGutter = isFullscreenEnvEnabled() ? gutterWidthOf(bounded) : 0
  const effectiveGutterWidth =
    splitGutter > 0 && splitGutter < renderWidth ? splitGutter : 0
  const cacheKey = `${themeName}\0${renderWidth}\0${dim ? '1' : '0'}\0${effectiveGutterWidth}\0${normalizedFirstLine ?? ''}\0${filePath ?? ''}`

  const existing = hunkCache.get(patch)?.get(cacheKey)
  if (existing) return existing

  const ColorDiffCtor = expectColorDiff()
  if (!ColorDiffCtor) return null

  try {
    const renderer = new ColorDiffCtor(
      bounded,
      normalizedFirstLine,
      filePath,
      fileContent,
    )
    const rendered: string[] | null = renderer.render(themeName, renderWidth, dim)
    if (!rendered) return null

    const entry: CacheEntry =
      effectiveGutterWidth > 0
        ? {
            lines: rendered,
            gutters: rendered.map(line =>
              sliceAnsi(line, 0, effectiveGutterWidth),
            ),
            contents: rendered.map(line =>
              sliceAnsi(line, effectiveGutterWidth),
            ),
            gutterWidth: effectiveGutterWidth,
          }
        : {
            lines: rendered,
            gutters: null,
            contents: null,
            gutterWidth: 0,
          }

    let perPatch = hunkCache.get(patch)
    if (!perPatch) {
      perPatch = new Map<string, CacheEntry>()
      hunkCache.set(patch, perPatch)
    }
    if (perPatch.size >= HUNK_CACHE_LIMIT) {
      const oldestKey = perPatch.keys().next().value
      if (oldestKey !== undefined) {
        perPatch.delete(oldestKey)
      }
    }
    perPatch.set(cacheKey, entry)
    return entry
  } catch (error) {
    logError(error)
    return null
  }
}

export const StructuredDiff: React.NamedExoticComponent<StructuredDiffProps> =
  React.memo(function StructuredDiff({
    patch,
    dim,
    width,
    filePath,
    firstLine,
    fileContent,
    skipHighlighting = false,
  }: StructuredDiffProps): React.ReactNode {
    const [themeName] = useTheme()
    const settings = useSettings()
    const bounded = expandPatchTabs(boundPatchForRender(patch))
    const renderWidth = Math.max(1, Math.floor(width))
    const syntaxDisabled =
      skipHighlighting || Boolean(settings.view?.syntaxOff) || colorStripped()

    if (!syntaxDisabled) {
      const normalizedFirstLine =
        firstLine && firstLine.length > 0
          ? firstLine.length > DIFF_LINE_RENDER_CAP
            ? firstLine.slice(0, DIFF_LINE_RENDER_CAP)
            : firstLine
          : undefined
      const entry = renderNativeDiff(
        patch,
        bounded,
        themeName,
        renderWidth,
        dim,
        filePath,
        normalizedFirstLine,
        fileContent,
      )
      if (entry) {
        return <DiffLine entry={entry} width={renderWidth} />
      }
    }

    return (
      <StructuredDiffFallback
        patch={bounded}
        dim={dim}
        width={renderWidth}
      />
    )
  })

export default StructuredDiff
