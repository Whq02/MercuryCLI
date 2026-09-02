// Renders a pre-formatted ANSI string as React text: the display parser
// yields spans, adjacent equal spans merge, and each span becomes styled
// text / a link / plain text.

import React from 'react'
import { Parser } from './termio/display.js'
import type { Color as DisplayColor, TextStyle } from './termio/display-types.js'
import type { Color } from './styles.js'
import Link from './components/Link.js'
import Text, { type Props as TextProps } from './components/Text.js'

type SpanStyle = {
  color?: Color
  backgroundColor?: Color
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  inverse?: boolean
}

type Span = {
  text: string
  props: SpanStyle
  hyperlink?: string
}

const NAMED_TO_ANSI: Record<string, string> = {
  black: 'ansi:black',
  red: 'ansi:red',
  green: 'ansi:green',
  yellow: 'ansi:yellow',
  blue: 'ansi:blue',
  magenta: 'ansi:magenta',
  cyan: 'ansi:cyan',
  white: 'ansi:white',
  brightBlack: 'ansi:blackBright',
  brightRed: 'ansi:redBright',
  brightGreen: 'ansi:greenBright',
  brightYellow: 'ansi:yellowBright',
  brightBlue: 'ansi:blueBright',
  brightMagenta: 'ansi:magentaBright',
  brightCyan: 'ansi:cyanBright',
  brightWhite: 'ansi:whiteBright',
}

function convertColor(color: DisplayColor): Color | undefined {
  switch (color.type) {
    case 'named':
      return NAMED_TO_ANSI[color.name] as Color | undefined
    case 'indexed':
      return `ansi256(${color.index})`
    case 'rgb':
      return `rgb(${color.r},${color.g},${color.b})`
    default:
      return undefined
  }
}

function convertStyle(style: TextStyle): SpanStyle {
  const props: SpanStyle = {}
  const color = convertColor(style.fg)
  const backgroundColor = convertColor(style.bg)
  if (color) props.color = color
  if (backgroundColor) props.backgroundColor = backgroundColor
  if (style.bold) props.bold = true
  if (style.dim) props.dim = true
  if (style.italic) props.italic = true
  if (style.underline !== 'none') props.underline = true
  if (style.strikethrough) props.strikethrough = true
  if (style.inverse) props.inverse = true
  return props
}

function sameProps(a: SpanStyle, b: SpanStyle): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.inverse === b.inverse
  )
}

function hasProps(props: SpanStyle): boolean {
  return Object.keys(props).length > 0
}

function parseSpans(input: string): Span[] {
  const parser = new Parser()
  const spans: Span[] = []
  let hyperlink: string | undefined
  for (const action of parser.feed(input)) {
    if (action.type === 'link') {
      hyperlink = action.action.type === 'start' ? action.action.url : undefined
      continue
    }
    if (action.type !== 'text') continue
    let text = ''
    for (const grapheme of action.graphemes) text += grapheme.value
    if (text === '') continue
    const props = convertStyle(action.style)
    const previous = spans[spans.length - 1]
    if (
      previous &&
      previous.hyperlink === hyperlink &&
      sameProps(previous.props, props)
    ) {
      previous.text += text
      continue
    }
    spans.push(hyperlink !== undefined ? { text, props, hyperlink } : { text, props })
  }
  return spans
}

// bold and dim are mutually exclusive on the text primitive: dim wins.
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
