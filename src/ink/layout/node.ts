type Pascal<Word extends string> = Word extends `${infer Head}-${infer Tail}`
  ? `${Capitalize<Head>}${Pascal<Tail>}`
  : Capitalize<Word>

type Named<Words extends readonly string[]> = {
  readonly [Word in Words[number] as Pascal<Word>]: Word
}

function pascal(word: string): string {
  return word
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function vocabulary<const Words extends readonly string[]>(words: Words): Named<Words> {
  return Object.fromEntries(words.map(word => [pascal(word), word])) as Named<Words>
}

const EDGES = ['all', 'horizontal', 'vertical', 'left', 'right', 'top', 'bottom', 'start', 'end'] as const
const GUTTERS = ['all', 'column', 'row'] as const
const DISPLAYS = ['flex', 'none'] as const
const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'] as const
const ALIGNMENTS = ['auto', 'stretch', 'flex-start', 'center', 'flex-end'] as const
const JUSTIFICATIONS = ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'] as const
const WRAPS = ['nowrap', 'wrap', 'wrap-reverse'] as const
const POSITION_TYPES = ['relative', 'absolute'] as const
const OVERFLOWS = ['visible', 'hidden', 'scroll'] as const
const MEASURE_MODES = ['undefined', 'exactly', 'at-most'] as const

export type LayoutEdge = (typeof EDGES)[number]
export type LayoutGutter = (typeof GUTTERS)[number]
export type LayoutDisplay = (typeof DISPLAYS)[number]
export type LayoutFlexDirection = (typeof FLEX_DIRECTIONS)[number]
export type LayoutAlign = (typeof ALIGNMENTS)[number]
export type LayoutJustify = (typeof JUSTIFICATIONS)[number]
export type LayoutWrap = (typeof WRAPS)[number]
export type LayoutPositionType = (typeof POSITION_TYPES)[number]
export type LayoutOverflow = (typeof OVERFLOWS)[number]
export type LayoutMeasureMode = (typeof MEASURE_MODES)[number]

export const LayoutEdge = vocabulary(EDGES)
export const LayoutGutter = vocabulary(GUTTERS)
export const LayoutDisplay = vocabulary(DISPLAYS)
export const LayoutFlexDirection = vocabulary(FLEX_DIRECTIONS)
export const LayoutAlign = vocabulary(ALIGNMENTS)
export const LayoutJustify = vocabulary(JUSTIFICATIONS)
export const LayoutWrap = vocabulary(WRAPS)
export const LayoutPositionType = vocabulary(POSITION_TYPES)
export const LayoutOverflow = vocabulary(OVERFLOWS)
export const LayoutMeasureMode = vocabulary(MEASURE_MODES)

export type LayoutMeasureFunc = (width: number, widthMode: LayoutMeasureMode) => { width: number; height: number }

type Setters<Facts extends Record<string, unknown>> = {
  [Fact in keyof Facts & string as `set${Fact}`]: (value: Facts[Fact]) => void
}

type Dimension = 'Width' | 'Height' | 'MinWidth' | 'MinHeight' | 'MaxWidth' | 'MaxHeight'

type DimensionSetters = Setters<Record<Dimension | `${Dimension}Percent`, number>> & {
  [Side in 'Width' | 'Height' as `set${Side}Auto`]: () => void
}

type EdgeSetters = {
  [Box in 'Position' | 'PositionPercent' | 'Margin' | 'Padding' | 'Border' as `set${Box}`]: (
    edge: LayoutEdge,
    value: number,
  ) => void
}

type FlexSetters = Setters<{
  FlexDirection: LayoutFlexDirection
  FlexGrow: number
  FlexShrink: number
  FlexBasis: number
  FlexBasisPercent: number
  FlexWrap: LayoutWrap
  AlignItems: LayoutAlign
  AlignSelf: LayoutAlign
  JustifyContent: LayoutJustify
}> & {
  setGap(gutter: LayoutGutter, value: number): void
}

type PlacementSetters = Setters<{
  Display: LayoutDisplay
  PositionType: LayoutPositionType
  Overflow: LayoutOverflow
}> & {
  getDisplay(): LayoutDisplay
}

type ComputedReads = {
  [Side in 'Left' | 'Top' | 'Width' | 'Height' as `getComputed${Side}`]: () => number
} & {
  [Box in 'Border' | 'Padding' as `getComputed${Box}`]: (edge: LayoutEdge) => number
}

type TreeLinks = {
  insertChild(child: LayoutNode, index: number): void
  removeChild(child: LayoutNode): void
  getChildCount(): number
  getParent(): LayoutNode | null
}

type LayoutPass = {
  calculateLayout(width?: number, height?: number): void
  setMeasureFunc(fn: LayoutMeasureFunc): void
  unsetMeasureFunc(): void
  markDirty(): void
}

type Lifecycle = {
  free(): void
  freeRecursive(): void
}

export type LayoutNode = TreeLinks &
  LayoutPass &
  ComputedReads &
  DimensionSetters &
  EdgeSetters &
  FlexSetters &
  PlacementSetters &
  Lifecycle
