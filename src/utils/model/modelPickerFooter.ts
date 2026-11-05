import { MODEL_PICKER_CONTEXT_WORDS } from './modelPickerGroups.js'

type ModelPickerFooterHeading = { fold: 'folded' | 'open' }

export type ModelPickerFooterKeys = { action?: string; window: boolean; stop?: string; share?: string; terminate?: string; support: boolean; legend?: readonly string[] }

export const MODEL_PICKER_EXIT_WORDS = 'esc or click outside closes'
const MODEL_PICKER_SHORT_EXIT_WORDS = 'esc closes'
const MODEL_PICKER_WINDOW_WORDS = '←→ window'
const MODEL_PICKER_SUPPORT_WORDS = 'c copies the support line'

export function modelPickerFooter(
  opts: {
    gated: boolean
    enableFlag?: string
    heading?: ModelPickerFooterHeading
    filterFocus?: boolean
    filtering?: boolean
    keys?: ModelPickerFooterKeys
  },
  innerWidth: number,
): string {
  const keys = opts.heading === undefined && opts.filterFocus !== true ? opts.keys : undefined
  if (keys?.legend !== undefined) return keys.legend.join(' · ')
  const head = '↑↓ select'
  const tail = opts.filtering ? 'esc clears the search' : MODEL_PICKER_EXIT_WORDS
  const action = opts.heading !== undefined
    ? opts.heading.fold === 'folded' ? '↵ unfold' : '↵ fold'
    : opts.gated
      ? `gated${opts.enableFlag ? ` (${opts.enableFlag})` : ''}`
      : '↵ switch'
  const middle = keys !== undefined
    ? [
        { text: keys.action ?? '', show: keys.action !== undefined, drop: 0 },
        { text: MODEL_PICKER_WINDOW_WORDS, show: keys.window, drop: 1 },
        { text: keys.stop ?? '', show: keys.stop !== undefined, drop: 2 },
        { text: keys.share ?? '', show: keys.share !== undefined, drop: 3 },
        { text: keys.terminate ?? '', show: keys.terminate !== undefined, drop: 2.2 },
        { text: MODEL_PICKER_SUPPORT_WORDS, show: keys.support, drop: 2.5 },
        { text: 'tab to search', show: true, drop: 4 },
      ]
    : [
        { text: 'type to search', show: opts.filterFocus === true, drop: 0 },
        { text: action, show: true, drop: 1 },
        { text: MODEL_PICKER_CONTEXT_WORDS, show: opts.filterFocus !== true, drop: 3 },
        { text: '→ ← fold', show: opts.filterFocus !== true, drop: 2 },
        { text: 'tab to search', show: opts.filterFocus !== true, drop: 4 },
        { text: 'tab back to the rows', show: opts.filterFocus === true, drop: 2 },
      ]
  const shortenBelow = keys !== undefined && tail === MODEL_PICKER_EXIT_WORDS ? 4 : -1
  const join = (parts: string[]): string => parts.join(' · ')
  let shown = middle.filter(s => s.show)
  let exit = tail
  const fits = (): boolean => join([head, ...shown.map(s => s.text), exit]).length <= innerWidth
  while (!fits() && shown.length > 0) {
    let victim = 0
    for (let k = 1; k < shown.length; k++) if (shown[k]!.drop > shown[victim]!.drop) victim = k
    if (shown[victim]!.drop < shortenBelow && exit === MODEL_PICKER_EXIT_WORDS) {
      exit = MODEL_PICKER_SHORT_EXIT_WORDS
      continue
    }
    shown = shown.filter((_, k) => k !== victim)
  }
  const line = join([head, ...shown.map(s => s.text), exit])
  return line.length <= innerWidth || opts.filterFocus ? line : join([head, ...shown.map(s => s.text), MODEL_PICKER_SHORT_EXIT_WORDS])
}
