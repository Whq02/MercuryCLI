// Highlighted code: the syntax highlighter unless disabled in
// settings or unavailable (the fallback is told which); width starts at 80
// and settles to the measured width minus 2; in fullscreen a line-number
// gutter is reserved and marked non-selectable per line, so a copy excludes
// the numbers while the code stays selectable.

import React, { memo, useLayoutEffect, useRef, useState } from 'react'
import { Ansi, Box, NoSelect, Text, measureElement } from '../ink.js'
import type { DOMElement } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js'
import { Suspense } from 'react'

export const HighlightedCode = memo(function HighlightedCode({
  code,
  filePath,
  width,
  dim = false,
}: {
  code: string
  filePath: string
  width?: number
  dim?: boolean
}): React.ReactNode {
  const highlightingDisabled = useAppState(
    state => state.settings.syntaxHighlightingDisabled === true,
  )
  const boxRef = useRef<DOMElement | null>(null)
  const [measured, setMeasured] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (width !== undefined) return
    if (boxRef.current) {
      const { width: measuredWidth } = measureElement(boxRef.current)
      if (measuredWidth > 0) setMeasured(measuredWidth - 2)
    }
  })

  const effectiveWidth = width ?? measured ?? 80

  const body = (
    <HighlightedCodeFallback
      code={code}
      filePath={filePath}
      dim={dim}
      skipColoring={highlightingDisabled}
    />
  )

  if (!isFullscreenEnvEnabled()) {
    return (
      <Box ref={boxRef} width={width} flexDirection="column">
        {body}
      </Box>
    )
  }

  // Fullscreen: the highlighted body is split per line at the gutter offset
  // so the reserved line-number gutter can be non-selectable while the code
  // half stays selectable. The gutter width is the digit count of the total
  // line count plus 2.
  const lines = code.split('\n')
  const gutterWidth = String(lines.length).length + 2
  void effectiveWidth
  return (
    <Box ref={boxRef} width={width} flexDirection="column">
      {lines.map((line, index) => (
        <Box key={index}>
          <NoSelect fromLeftEdge>
            <Text dimColor>
              {String(index + 1).padStart(gutterWidth - 2)}
              {'  '}
            </Text>
          </NoSelect>
          <Suspense fallback={<Ansi dimColor={dim}>{line === '' ? ' ' : line}</Ansi>}>
            <HighlightedCodeFallback
              code={line === '' ? ' ' : line}
              filePath={filePath}
              dim={dim}
              skipColoring={highlightingDisabled}
            />
          </Suspense>
        </Box>
      ))}
    </Box>
  )
})

export default HighlightedCode
