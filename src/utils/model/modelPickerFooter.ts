import { MODEL_PICKER_CONTEXT_WORDS } from './modelPickerGroups.js'

type ModelPickerFooterHeading = { fold: 'folded' | 'open' }

export const MODEL_PICKER_EXIT_WORDS = 'esc or click outside closes'

export function modelPickerFooter(
  opts: {
    gated: boolean
    enableFlag?: string
    heading?: ModelPickerFooterHeading
    filterFocus?: boolean
    filtering?: boolean
  },
  innerWidth: number,
): string {
  const head = '↑↓ select'
  const tail = opts.filtering ? 'esc clears the search' : MODEL_PICKER_EXIT_WORDS
  const action = opts.heading !== undefined
    ? opts.heading.fold === 'folded' ? '↵ unfold' : '↵ fold'
    : opts.gated
      ? `gated${opts.enableFlag ? ` (${opts.enableFlag})` : ''}`
      : '↵ switch'
  const middle = [
    { text: 'type to search', show: opts.filterFocus === true, drop: 0 },
    { text: action, show: true, drop: 1 },
    { text: MODEL_PICKER_CONTEXT_WORDS, show: opts.filterFocus !== true, drop: 3 },
    { text: '→ ← fold', show: opts.filterFocus !== true, drop: 2 },
    { text: 'tab to search', show: opts.filterFocus !== true, drop: 4 },
    { text: 'tab back to the rows', show: opts.filterFocus === true, drop: 2 },
  ]
  const join = (parts: string[]): string => parts.join(' · ')
  let shown = middle.filter(s => s.show)
  const fits = (): boolean => join([head, ...shown.map(s => s.text), tail]).length <= innerWidth
  while (!fits() && shown.length > 0) {
    let victim = 0
    for (let k = 1; k < shown.length; k++) if (shown[k]!.drop > shown[victim]!.drop) victim = k
    shown = shown.filter((_, k) => k !== victim)
  }
  const line = join([head, ...shown.map(s => s.text), tail])
  return line.length <= innerWidth || opts.filterFocus ? line : join([head, ...shown.map(s => s.text), 'esc closes'])
}
