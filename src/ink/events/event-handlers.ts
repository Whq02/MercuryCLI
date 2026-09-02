// Event-type → handler-prop mapping, and the set of props the reconciler
// stores in the handler map instead of the attribute map. The prop names are
// public API.

import type { ClickEvent } from './click-event.js'
import type { FocusEvent } from './focus-event.js'
import type { KeyboardEvent } from './keyboard-event.js'
import type { PasteEvent } from './paste-event.js'
import type { ResizeEvent } from './resize-event.js'

export const HANDLER_FOR_EVENT: Record<
  string,
  { capture?: string; bubble: string; bubbles: boolean }
> = {
  keydown: { capture: 'onKeyDownCapture', bubble: 'onKeyDown', bubbles: true },
  focus: { capture: 'onFocusCapture', bubble: 'onFocus', bubbles: true },
  blur: { capture: 'onBlurCapture', bubble: 'onBlur', bubbles: true },
  paste: { capture: 'onPasteCapture', bubble: 'onPaste', bubbles: true },
  resize: { bubble: 'onResize', bubbles: false },
  click: { bubble: 'onClick', bubbles: false },
}

export type EventHandlerProps = {
  onKeyDown?: (event: KeyboardEvent) => void
  onKeyDownCapture?: (event: KeyboardEvent) => void
  onFocus?: (event: FocusEvent) => void
  onFocusCapture?: (event: FocusEvent) => void
  onBlur?: (event: FocusEvent) => void
  onBlurCapture?: (event: FocusEvent) => void
  onPaste?: (event: PasteEvent) => void
  onPasteCapture?: (event: PasteEvent) => void
  onResize?: (event: ResizeEvent) => void
  onClick?: (event: ClickEvent) => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

// onMouseEnter/onMouseLeave are dispatched directly by the hover pass, not
// through the table above, but must still live off the attribute map.
export const EVENT_HANDLER_PROPS = new Set([
  'onKeyDown',
  'onKeyDownCapture',
  'onFocus',
  'onFocusCapture',
  'onBlur',
  'onBlurCapture',
  'onPaste',
  'onPasteCapture',
  'onResize',
  'onClick',
  'onMouseEnter',
  'onMouseLeave',
])
