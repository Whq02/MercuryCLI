import React from 'react'
import { Parser } from './termio/display.js'
import type { Color as DisplayColor, TextStyle } from './termio/display-types.js'
import type { Color } from './styles.js'
import Link from './components/Link.js'
import Text, { type Props as TextProps } from './components/Text.js'

const NAMED_TO_ANSI: Record<string, Color> = {
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

function convertColor(color: DisplayColor): Color | undefined {
  switch (color.type) {
    case 'default':
      return undefined
    case 'named':
      return Object.hasOwn(NAMED_TO_ANSI, color.name) ? NAMED_TO_ANSI[color.name] : undefined
    case 'indexed':
      return `ansi256(${color.index})`
    case 'rgb':
      return `rgb(${color.r},${color.g},${color.b})`
  }
}

function convertStyle(style: TextStyle): SpanStyle {
  const out: SpanStyle = {}
  const color = convertColor(style.fg)
  if (color !== undefined) out.color = color
  const backgroundColor = convertColor(style.bg)
  if (backgroundColor !== undefined) out.backgroundColor = backgroundColor
  if (style.bold) out.bold = true
  if (style.dim) out.dim = true
  if (style.italic) out.italic = true
  if (style.underline !== 'none') out.underline = true
  if (style.strikethrough) out.strikethrough = true
  if (style.inverse) out.inverse = true
  return out
}

function sameStyle(a: SpanStyle, b: SpanStyle): boolean {
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
  const actions = parser.feed(input)
  const spans: Span[] = []
  let currentLink: string | undefined

  for (const item of actions) {
    if (item.type === 'link') {
      if (item.action.type === 'start') {
        currentLink = item.action.url
      } else {
        currentLink = undefined
      }
      continue
    }
    if (item.type !== 'text') continue
    let text = ''
    for (const grapheme of item.graphemes) {
      text += grapheme.value
    }
    if (text === '') continue
    const props = convertStyle(item.style)
    const prev = spans[spans.length - 1]
    if (prev && prev.hyperlink === currentLink && sameStyle(prev.props, props)) {
      prev.text += text
    } else if (currentLink !== undefined) {
      spans.push({ text, props, hyperlink: currentLink })
    } else {
      spans.push({ text, props })
    }
  }
  return spans
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
