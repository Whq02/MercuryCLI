// The display-parser action / style / colour vocabulary — a frozen contract
// shape shared by the parser, the ANSI-rendering component, the OSC layer
// and the tab-status hook.

export type NamedColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'

export type Color =
  | { type: 'named'; name: NamedColor }
  | { type: 'indexed'; index: number }
  | { type: 'rgb'; r: number; g: number; b: number }
  | { type: 'default' }

export type UnderlineStyle = 'none' | 'single' | 'double' | 'curly' | 'dotted' | 'dashed'

export type TextStyle = {
  bold: boolean
  dim: boolean
  italic: boolean
  blink: boolean
  inverse: boolean
  hidden: boolean
  strikethrough: boolean
  overline: boolean
  underline: UnderlineStyle
  fg: Color
  bg: Color
  underlineColor: Color
}

export function defaultStyle(): TextStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    blink: false,
    inverse: false,
    hidden: false,
    strikethrough: false,
    overline: false,
    underline: 'none',
    fg: { type: 'default' },
    bg: { type: 'default' },
    underlineColor: { type: 'default' },
  }
}

export function colorsEqual(a: Color, b: Color): boolean {
  if (a.type !== b.type) return false
  switch (a.type) {
    case 'named':
      return a.name === (b as { name: NamedColor }).name
    case 'indexed':
      return a.index === (b as { index: number }).index
    case 'rgb': {
      const other = b as { r: number; g: number; b: number }
      return a.r === other.r && a.g === other.g && a.b === other.b
    }
    default:
      return true
  }
}

export function stylesEqual(a: TextStyle, b: TextStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.blink === b.blink &&
    a.inverse === b.inverse &&
    a.hidden === b.hidden &&
    a.strikethrough === b.strikethrough &&
    a.overline === b.overline &&
    a.underline === b.underline &&
    colorsEqual(a.fg, b.fg) &&
    colorsEqual(a.bg, b.bg) &&
    colorsEqual(a.underlineColor, b.underlineColor)
  )
}

export type CursorDirection = 'up' | 'down' | 'forward' | 'back'

export type CursorAction =
  | { type: 'move'; direction: CursorDirection; count: number }
  | { type: 'position'; row: number; col: number }
  | { type: 'column'; col: number }
  | { type: 'row'; row: number }
  | { type: 'save' }
  | { type: 'restore' }
  | { type: 'show' }
  | { type: 'hide' }
  | { type: 'style'; style: 'block' | 'underline' | 'bar'; blinking: boolean }
  | { type: 'nextLine'; count: number }
  | { type: 'prevLine'; count: number }

export type EraseAction =
  | { type: 'display'; region: 'toEnd' | 'toStart' | 'all' | 'scrollback' }
  | { type: 'line'; region: 'toEnd' | 'toStart' | 'all' }
  | { type: 'chars'; count: number }

export type ScrollAction =
  | { type: 'up'; count: number }
  | { type: 'down'; count: number }
  | { type: 'setRegion'; top: number; bottom: number }

export type ModeAction =
  | { type: 'alternateScreen'; enabled: boolean }
  | { type: 'bracketedPaste'; enabled: boolean }
  | { type: 'mouseTracking'; mode: 'off' | 'normal' | 'button' | 'any' }
  | { type: 'focusEvents'; enabled: boolean }

export type LinkAction =
  | { type: 'start'; url: string; params?: Record<string, string> }
  | { type: 'end' }

export type TitleAction =
  | { type: 'windowTitle'; title: string }
  | { type: 'iconName'; name: string }
  | { type: 'both'; title: string }

/** The tri-state tab-status record: an absent member means "no change", a
 *  null member means "explicitly clear", a value sets. */
export type TabStatusAction = {
  indicator?: Color | null
  status?: string | null
  statusColor?: Color | null
}

/** A visual character unit: 1 or 2 columns. */
export type Grapheme = {
  value: string
  width: 1 | 2
}

export type TextSegment = {
  type: 'text'
  text: string
  style: TextStyle
}

export type Action =
  | { type: 'text'; graphemes: Grapheme[]; style: TextStyle }
  | { type: 'cursor'; action: CursorAction }
  | { type: 'erase'; action: EraseAction }
  | { type: 'scroll'; action: ScrollAction }
  | { type: 'mode'; action: ModeAction }
  | { type: 'link'; action: LinkAction }
  | { type: 'title'; action: TitleAction }
  | { type: 'tabStatus'; action: TabStatusAction }
  | { type: 'sgr'; params: string }
  | { type: 'bell' }
  | { type: 'reset' }
  | { type: 'unknown'; sequence: string }
