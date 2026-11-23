import React, { memo, useRef, useState } from 'react'
import { useMeasure } from '../hooks/effects.js'
import { Ansi, Box, NoSelect, Text, measureElement } from '../ink.js'
import type { DOMElement } from '../ink.js'
import { useAppState } from '../state/AppState.js'
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { linkifyCodeUrls } from '../utils/hyperlink.js'
import { HighlightedCodeFallback } from './HighlightedCode/Fallback.js'
import { Suspense } from 'react'

export type HighlightedCodeProps = {
  code: string
  filePath: string
  width?: number
  dim?: boolean
}

export const HighlightedCode: React.NamedExoticComponent<HighlightedCodeProps> = memo(
  function HighlightedCode({
    code,
    filePath,
    width,
    dim = false,
  }: HighlightedCodeProps): React.ReactNode {
    const syntaxOff = useAppState(s => s.settings.view?.syntaxOff) === true
    const boxRef = useRef<DOMElement | null>(null)
    const [, setMeasuredWidth] = useState<number | undefined>(undefined)

    useMeasure(() => {
      if (width !== undefined || !boxRef.current) return
      const measured = measureElement(boxRef.current).width
      if (measured > 0) {
        const next = measured - 2
        setMeasuredWidth(prev => (prev === next ? prev : next))
      }
    })

    const boxProps = width !== undefined ? { width } : {}

    if (!isFullscreenEnvEnabled()) {
      return (
        <Box ref={boxRef} flexDirection="column" {...boxProps}>
          <HighlightedCodeFallback
            code={code}
            filePath={filePath}
            dim={dim}
            skipColoring={syntaxOff}
          />
        </Box>
      )
    }

    const lines = code.split('\n')
    const gutterDigits = String(lines.length).length

    return (
      <Box ref={boxRef} flexDirection="column" {...boxProps}>
        {lines.map((line, index) => {
          const lineText = line === '' ? ' ' : line
          const gutter = `${String(index + 1).padStart(gutterDigits)}  `
          return (
            <Box key={index} flexDirection="row">
              <NoSelect fromLeftEdge flexShrink={0}>
                <Text dimColor>{gutter}</Text>
              </NoSelect>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Suspense
                  fallback={<Ansi dimColor={dim}>{linkifyCodeUrls(lineText)}</Ansi>}
                >
                  <HighlightedCodeFallback
                    code={lineText}
                    filePath={filePath}
                    dim={dim}
                    skipColoring={syntaxOff}
                  />
                </Suspense>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  },
)

export default HighlightedCode
