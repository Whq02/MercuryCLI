import React from 'react'
import { Parser } from './termio/display.js'
import type { Color as DisplayColor, TextStyle } from './termio/display-types.js'
import type { Color } from './styles.js'
import Link from './components/Link.js'
import Text, { type Props as TextProps } from './components/Text.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type SpanStyle = Unbuilt

type Span = Unbuilt

function hasProps(props: SpanStyle): boolean {
  return Object.keys(props).length > 0
}

function parseSpans(input: string): Span[] {
  return notBuilt('src/ink/Ansi.tsx:90')
}

function textProps(props: SpanStyle, forceDim: boolean): TextProps {
  const base = {
    color: props.color,
    backgroundColor: props.backgroundColor,
    italic: props.italic,
    underline: props.underline,
    strikethrough: props.strikethrough,
    inverse: props.inverse,
  }
  if (forceDim || props.dim) return { ...base, dim: true }
  if (props.bold) return { ...base, bold: true }
  return base
}

type Props = {
  readonly children: string
  readonly dimColor?: boolean
}

export const Ansi = React.memo(function Ansi({
  children,
  dimColor = false,
}: Props): React.ReactNode {
  if (typeof children !== 'string') {
    return <Text dim={dimColor}>{String(children)}</Text>
  }
  if (children === '') return null

  const spans = parseSpans(children)
  if (spans.length === 0) return null
  if (spans.length === 1 && !hasProps(spans[0]!.props) && !spans[0]!.hyperlink) {
    return <Text dim={dimColor}>{spans[0]!.text}</Text>
  }

  return (
    <Text dim={dimColor}>
      {spans.map((span, index) => {
        const styled = hasProps(span.props)
        if (span.hyperlink && styled) {
          return (
            <Link key={index} url={span.hyperlink}>
              <Text {...textProps(span.props, dimColor)}>{span.text}</Text>
            </Link>
          )
        }
        if (span.hyperlink) {
          return (
            <Link key={index} url={span.hyperlink}>
              {span.text}
            </Link>
          )
        }
        if (styled) {
          return (
            <Text key={index} {...textProps(span.props, dimColor)}>
              {span.text}
            </Text>
          )
        }
        return span.text
      })}
    </Text>
  )
})
