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

type LinePart = {
  text: string
  highlight: TextHighlight | undefined
  start: number
}

export function HighlightedInput({
  text,
  highlights,
  baseColor,
}: Props): React.ReactNode {
  const { lines, hasShimmer, sweepStart, cycleLength } = React.useMemo(() => {
    const segments = segmentTextByHighlights(text, highlights)

    const lines: LinePart[][] = [[]]
    let pos = 0
    for (const segment of segments) {
      const parts = segment.text.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          lines.push([])
          pos += 1
        }
        const part = parts[i]!
        if (part.length > 0) {
          lines[lines.length - 1]!.push({
            text: part,
            highlight: segment.highlight,
            start: pos,
          })
        }
        pos += part.length
      }
    }

    const hasShimmer = highlights.some(h => h.shimmerColor)
    let sweepStart = 0
    let cycleLength = 1
    if (hasShimmer) {
      const padding = 10
      let lo = Infinity
      let hi = -Infinity
      for (const h of highlights) {
        if (h.shimmerColor) {
          lo = Math.min(lo, h.start)
          hi = Math.max(hi, h.end)
        }
      }
      sweepStart = lo - padding
      cycleLength = hi - lo + padding * 2
    }

    return { lines, hasShimmer, sweepStart, cycleLength }
  }, [text, highlights])

  const [ref, time] = useAnimationFrame(hasShimmer ? 50 : null)
  const glimmerIndex = hasShimmer
    ? sweepStart + (Math.floor(time / 50) % cycleLength)
    : -100

  return (
    <Box ref={ref} flexDirection="column">
      {lines.map((lineParts, lineIndex) => (
        <Box key={lineIndex}>
          {lineParts.length === 0 ? (
            <Text> </Text>
          ) : (
            lineParts.map((part, partIndex) => {
              if (part.highlight?.shimmerColor && part.highlight.color) {
                return (
                  <Text key={partIndex}>
                    {part.text.split('').map((char, charIndex) => (
                      <ShimmerChar
                        key={charIndex}
                        char={char}
                        index={part.start + charIndex}
                        glimmerIndex={glimmerIndex}
                        messageColor={part.highlight!.color!}
                        shimmerColor={part.highlight!.shimmerColor!}
                      />
                    ))}
                  </Text>
                )
              }
              return (
                <Text
                  key={partIndex}
                  color={part.highlight?.color ?? baseColor}
                  dimColor={part.highlight?.dimColor}
                  inverse={part.highlight?.inverse}
                >
                  <Ansi>{part.text}</Ansi>
                </Text>
              )
            })
          )}
        </Box>
      ))}
    </Box>
  )
}
