type Tagged<Table> = {
  [Tag in keyof Table & string]: { type: Tag } & Table[Tag]
}[keyof Table & string]

type NoPayload = unknown

type BaseColorName = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'

export type NamedColor = BaseColorName | `bright${Capitalize<BaseColorName>}`

export type Color = Tagged<{
  named: { name: NamedColor }
  indexed: { index: number }
  rgb: { r: number; g: number; b: number }
  default: NoPayload
}>

export type UnderlineStyle = 'none' | 'single' | 'double' | 'curly' | 'dotted' | 'dashed'

const ATTRIBUTES = ['bold', 'dim', 'italic', 'blink', 'inverse', 'hidden', 'strikethrough', 'overline'] as const

type Attribute = (typeof ATTRIBUTES)[number]

type ColorSlot = 'fg' | 'bg' | 'underlineColor'

export type TextStyle = Record<Attribute, boolean> & { underline: UnderlineStyle } & Record<ColorSlot, Color>

export function defaultStyle(): TextStyle {
  const attributes = Object.fromEntries(ATTRIBUTES.map(attribute => [attribute, false])) as Record<Attribute, boolean>
  return {
    ...attributes,
    underline: 'none',
    fg: { type: 'default' },
    bg: { type: 'default' },
    underlineColor: { type: 'default' },
  }
}

type Count = { count: number }

type CursorAction = Tagged<{
  move: { direction: 'up' | 'down' | 'forward' | 'back' } & Count
  position: { row: number; col: number }
  column: { col: number }
  row: { row: number }
  save: NoPayload
  restore: NoPayload
  show: NoPayload
  hide: NoPayload
  style: { style: 'block' | 'underline' | 'bar'; blinking: boolean }
  nextLine: Count
  prevLine: Count
}>

type EraseAction = Tagged<{
  display: { region: 'toEnd' | 'toStart' | 'all' | 'scrollback' }
  line: { region: 'toEnd' | 'toStart' | 'all' }
  chars: Count
}>

type ScrollAction = Tagged<{
  up: Count
  down: Count
  setRegion: { top: number; bottom: number }
}>

type Switch = { enabled: boolean }

type ModeAction = Tagged<{
  alternateScreen: Switch
  bracketedPaste: Switch
  mouseTracking: { mode: 'off' | 'normal' | 'button' | 'any' }
  focusEvents: Switch
}>

type LinkAction = Tagged<{
  start: { url: string; params?: Record<string, string> }
  end: NoPayload
}>

type TitleAction = Tagged<{
  windowTitle: { title: string }
  iconName: { name: string }
  both: { title: string }
}>

export type TabStatusAction = {
  [Slot in 'indicator' | 'statusColor']?: Color | null
} & {
  status?: string | null
}

export type Grapheme = {
  value: string
  width: 1 | 2
}

type ActionFamilies = {
  cursor: CursorAction
  erase: EraseAction
  scroll: ScrollAction
  mode: ModeAction
  link: LinkAction
  title: TitleAction
  tabStatus: TabStatusAction
}

export type Action = Tagged<
  {
    [Family in keyof ActionFamilies]: { action: ActionFamilies[Family] }
  } & {
    text: { graphemes: Grapheme[]; style: TextStyle }
    sgr: { params: string }
    bell: NoPayload
    reset: NoPayload
    unknown: { sequence: string }
  }
>
