// Logical → visual reordering of a rendered character run for terminals
// without native bidi. Detection and the algorithm instance are both lazy
// and memoised: a session that never sees right-to-left text never pays.

import bidiFactory from 'bidi-js'

export type BidiChar = {
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
}

// Hebrew, Arabic (incl. supplements/presentation forms), Thaana, Syriac.
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

/** Reorder a run from logical to visual order; the input is returned
 *  unchanged on terminals with native bidi, for empty runs, and for pure
 *  left-to-right runs. Entries are permuted, never mutated. */
export function reorderBidi<T extends BidiChar>(characters: T[]): T[] {
  if (!needsSoftwareBidi()) return characters
  if (characters.length === 0) return characters
  const text = characters.map(c => c.value).join('')
  if (!RTL_RE.test(text)) return characters

  const { levels } = getBidi().getEmbeddingLevels(text)

  // Map string offsets back to run entries (an entry may span several code
  // units).
  const entryLevels: number[] = new Array(characters.length)
  let offset = 0
  for (let i = 0; i < characters.length; i++) {
    entryLevels[i] = levels[offset] ?? 0
    offset += characters[i]!.value.length
  }

  const out = characters.slice()
  const outLevels = entryLevels.slice()
  let maxLevel = 0
  for (const level of outLevels) if (level > maxLevel) maxLevel = level

  // Standard reordering: from the maximum level down to 1, reverse every
  // maximal contiguous run at or above that level (levels alongside).
  for (let level = maxLevel; level >= 1; level--) {
    let i = 0
    while (i < out.length) {
      if (outLevels[i]! < level) {
        i++
        continue
      }
      let j = i
      while (j < out.length && outLevels[j]! >= level) j++
      reverseRange(out, i, j - 1)
      reverseRange(outLevels, i, j - 1)
      i = j
    }
  }
  return out
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
