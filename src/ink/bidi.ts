
import bidiFactory from 'bidi-js'
import presentationData from './arabicPresentationForms.json'

type BidiChar = {
  value: string
  width: number
  styleId: number
  hyperlink: string | undefined
}

type BidiApi = {
  getEmbeddingLevels: (
    text: string,
    explicitDirection?: 'ltr' | 'rtl',
  ) => { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> }
  getMirroredCharactersMap: (text: string, levels: ReturnType<BidiApi['getEmbeddingLevels']>) => Map<number, string>
}

const RTL_RE =
  /[\u0590-\u05FF\uFB1D-\uFB4F\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0780-\u07BF\u0700-\u074F]/

let softwareBidi: boolean | null = null
let bidi: BidiApi | null = null

function needsSoftwareBidi(): boolean {
  if (softwareBidi === null) {
    softwareBidi =
      process.platform === 'win32' ||
      process.env.WT_SESSION !== undefined ||
      process.env.TERM_PROGRAM === 'vscode'
  }
  return softwareBidi
}

function getBidi(): BidiApi {
  if (!bidi) bidi = (bidiFactory as () => BidiApi)()
  return bidi
}

export function reorderBidi<T extends BidiChar>(characters: T[]): T[] {
  if (!needsSoftwareBidi()) return characters
  if (characters.length === 0) return characters
  const text = characters.map(c => c.value).join('')
  if (!RTL_RE.test(text)) return characters

  const { levels } = getBidi().getEmbeddingLevels(text)

  const entryLevels: number[] = new Array(characters.length)
  let offset = 0
  for (let i = 0; i < characters.length; i++) {
    entryLevels[i] = levels[offset] ?? 0
    offset += characters[i]!.value.length
  }

  const out = characters.slice()

  reorderByLevels(out, entryLevels.slice())
  return out
}

function reorderByLevels<T>(items: T[], levels: number[]): void {
  let maxLevel = 0
  for (const level of levels) if (level > maxLevel) maxLevel = level
  for (let level = maxLevel; level >= 1; level--) {
    let i = 0
    while (i < items.length) {
      if (levels[i]! < level) {
        i++
        continue
      }
      let j = i
      while (j < items.length && levels[j]! >= level) j++
      reverseRange(items, i, j - 1)
      reverseRange(levels, i, j - 1)
      i = j
    }
  }
}

function reverseRange<T>(array: T[], from: number, to: number): void {
  while (from < to) {
    const tmp = array[from]!
    array[from] = array[to]!
    array[to] = tmp
    from++
    to--
  }
}

type ArabicForm = 'isolated' | 'initial' | 'medial' | 'final'
const presentationForms: Record<string, Partial<Record<ArabicForm, number>>> = presentationData.forms
const lamAlefForms: Record<string, Partial<Record<ArabicForm, number>>> = presentationData.lamAlef
const joiningTypes: Record<string, string> = presentationData.joining
const pointKey = (value: string): string => value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
const joiningType = (value: string): string => joiningTypes[pointKey(value)] ?? (/^[\p{Mn}\p{Me}\p{Cf}]$/u.test(value) ? 'T' : 'U')
const joinsLeft = (type: string): boolean => type === 'D' || type === 'L' || type === 'C'
const joinsRight = (type: string): boolean => type === 'D' || type === 'R' || type === 'C'

export function shapeBidiForTerminal<T extends BidiChar>(characters: T[]): T[] {
  const text = characters.map(c => c.value).join('')
  if (!RTL_RE.test(text)) return characters
  const embedding = getBidi().getEmbeddingLevels(text, 'ltr')
  const mirrors = getBidi().getMirroredCharactersMap(text, embedding)
  const points = Array.from(text)
  const shaped = points.slice()
  const offsets: number[] = []
  let offset = 0
  for (const point of points) {
    offsets.push(offset)
    offset += point.length
  }
  const neighbour = (i: number, step: number): number => {
    for (let j = i + step; j >= 0 && j < points.length; j += step) {
      if (joiningType(points[j]!) !== 'T') return j
    }
    return -1
  }
  const consumed = new Set<number>()
  for (let i = 0; i < points.length; i++) {
    if (consumed.has(i)) continue
    const point = points[i]!
    const forms = presentationForms[pointKey(point)]
    if (!forms) continue
    const before = neighbour(i, -1)
    const after = neighbour(i, 1)
    const joinedBefore = before >= 0 && joinsLeft(joiningType(points[before]!)) && joinsRight(joiningType(point))
    const joinedAfter = after >= 0 && joinsLeft(joiningType(point)) && joinsRight(joiningType(points[after]!))
    const ligature = point === '\u0644' && after >= 0 ? lamAlefForms[pointKey(points[after]!)] : undefined
    if (ligature) {
      shaped[i] = String.fromCodePoint(ligature[joinedBefore ? 'final' : 'isolated']!)
      shaped[after] = ' '
      consumed.add(after)
      continue
    }
    const form = joinedBefore ? (joinedAfter ? 'medial' : 'final') : (joinedAfter ? 'initial' : 'isolated')
    const mapped = forms[form]
    if (mapped !== undefined) shaped[i] = String.fromCodePoint(mapped)
  }
  const out: T[] = []
  const levels: number[] = []
  let pointIndex = 0
  for (const character of characters) {
    const count = Array.from(character.value).length
    const level = embedding.levels[offsets[pointIndex]!] ?? 0
    const emoji = /\p{Extended_Pictographic}/u.test(character.value)
    let value = ''
    for (let j = pointIndex; j < pointIndex + count; j++) {
      const point = points[j]!
      value += !emoji && (point === '\u200c' || point === '\u200d')
        ? ' '
        : mirrors.get(offsets[j]!) ?? shaped[j]!
    }
    if (level % 2) {
      value = emoji ? `\u2068${value}\u2069` : Array.from(value, point => `\u2068${point}\u2069`).join('')
    }
    out.push({ ...character, value })
    levels.push(level)
    pointIndex += count
  }
  reorderByLevels(out, levels)
  return out
}
