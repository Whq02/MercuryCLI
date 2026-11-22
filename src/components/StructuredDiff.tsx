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
import { unbuilt, type Unbuilt } from '../pi/holes.js'

type CacheEntry = Unbuilt

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

export const StructuredDiff: Unbuilt = unbuilt('src/components/StructuredDiff.tsx:117')

export default StructuredDiff
