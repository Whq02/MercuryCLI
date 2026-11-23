import * as React from 'react'
import { Ansi, Box, Text, useAnimationFrame } from '../../ink.js'
import {
  segmentTextByHighlights,
  type TextHighlight,
} from '../../utils/textHighlighting.js'
import { ShimmerChar } from '../Spinner/ShimmerChar.js'

type Props = {
  text: string
  highlights: TextHighlight[]
  baseColor?: string
}

type LineRun = {
  text: string
  highlight?: TextHighlight
  startOffset: number
}

export function HighlightedInput({
  text,
  highlights,
  baseColor,
}: Props): React.ReactNode {
  const shimmerHighlights = highlights.filter(
    highlight => Boolean(highlight.shimmerColor),
  )
  const hasShimmer = shimmerHighlights.length > 0
  const minStart = hasShimmer
    ? Math.min(...shimmerHighlights.map(highlight => highlight.start))
    : 0
  const maxEnd = hasShimmer
    ? Math.max(...shimmerHighlights.map(highlight => highlight.end))
    : 0
  const sweepStart = minStart - 10
  const cycleLength = Math.max(1, maxEnd - minStart + 20)
  const [viewportRef, time] = useAnimationFrame(hasShimmer ? 50 : null)
  const glimmerIndex = hasShimmer
    ? sweepStart + (Math.floor(time / 50) % cycleLength)
    : -100

  const segments = segmentTextByHighlights(text, highlights)
  const lines: LineRun[][] = [[]]
  for (const segment of segments) {
    let offset = segment.start
    const parts = segment.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([])
        offset += 1
      }
      const part = parts[i] ?? ''
      if (part.length > 0) {
        lines[lines.length - 1]!.push({
          text: part,
          highlight: segment.highlight,
          startOffset: offset,
        })
        offset += part.length
      }
    }
  }

  return (
    <Box ref={viewportRef} flexDirection="column">
      {lines.map((line, lineIndex) => {
        if (line.length === 0) {
          return <Text key={lineIndex}> </Text>
        }
        return (
          <Text key={lineIndex}>
            {line.map((run, runIndex) => {
              const highlight = run.highlight
              if (highlight?.shimmerColor && highlight.color) {
                const { color, shimmerColor } = highlight
                return (
                  <React.Fragment key={runIndex}>
                    {Array.from(run.text).map((char, charIndex) => (
                      <ShimmerChar
                        key={charIndex}
                        char={char}
                        index={run.startOffset + charIndex}
                        glimmerIndex={glimmerIndex}
                        messageColor={color}
                        shimmerColor={shimmerColor}
                      />
                    ))}
                  </React.Fragment>
                )
              }
              return (
                <Text
                  key={runIndex}
                  color={highlight?.color ?? baseColor}
                  dimColor={highlight?.dimColor}
                  inverse={highlight?.inverse}
                >
                  <Ansi>{run.text}</Ansi>
                </Text>
              )
            })}
          </Text>
        )
      })}
    </Box>
  )
}
