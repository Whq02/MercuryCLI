import React, { memo, useRef, useState } from 'react'
import { useMeasure } from '../effects/effects.js'
import { Ansi, Box, NoSelect, Text, measureElement } from '../themedRenderer.js'
import type { DOMElement } from '../themedRenderer.js'
import { useAppState } from '../app-state/AppState.js'
import { isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js'
import { linkifyCodeUrls } from '../../platform/text/hyperlink.js'
import { HighlightedCodeFallback } from './CliHighlightedCode.js'
import { Suspense } from 'react'

type HighlightedCodeProps = {
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

    if (!isFullscreenEnvEnabled()) {
      return (
        <Box ref={boxRef} width={width} flexDirection="column">
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
      <Box ref={boxRef} width={width} flexDirection="column">
        {lines.map((line, index) => {
          const lineText = line === '' ? ' ' : line
          const gutter = `${String(index + 1).padStart(gutterDigits)}  `
          return (
            <Box key={index}>
              <NoSelect fromLeftEdge flexShrink={0}>
                <Text dimColor>{gutter}</Text>
              </NoSelect>
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
          )
        })}
      </Box>
    )
  },
)

export default HighlightedCode
