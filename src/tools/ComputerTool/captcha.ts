import type { DesktopBounds, DesktopTree, DesktopTreeElement } from '../../services/desktop/driver.js'
import { clippedWords } from './fastRoad.js'

export type CaptchaSight = 'challenge' | 'widget' | null

const CAPTCHA_WIDGET_NOTE = 'note: the page carries a captcha widget; a badge is not a challenge and never stops an act'
const CAPTCHA_CHALLENGE_NOTE = 'a human-verification challenge is on screen: the next act asks the operator to complete it themselves or to let you try it; captcha: true on the act asks at once'
const CAPTCHA_GRANTED_NOTE = 'a human-verification challenge is on screen; the operator allowed you to try it in this window'
export const CAPTCHA_OPERATOR_COMPLETES = 'a human-verification challenge is on screen and the operator will complete it themselves — wait until it is gone, then re-issue'
export const CAPTCHA_ASK_UNAVAILABLE = 'a human-verification challenge is on screen and no permission host can ask the operator — re-issue with captcha: true once one can, or let the operator complete it, then re-issue'
export const CAPTCHA_QUESTION = 'a human-verification challenge is on screen: complete it yourself and Mercury carries on, or allow Mercury to try it in this window until the challenge is gone'

const CHALLENGE = /verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|verify\s+you\s+are\s+not\s+a\s+robot|i(?:['’]m|\s+am)\s+not\s+a\s+robot|i\s+am\s+human|are\s+you\s+a\s+robot|select\s+all\s+(?:the\s+)?(?:images|squares)/i
const BRAND = /\b(?:re[ -]?captcha|h[ -]?captcha|turnstile|captcha)\b/i
const TAB_STRIP_TAB = /^(?:AXRadioButton \(AXTabButton\)|TabItem)$/

export function titleSight(title: string): CaptchaSight {
  return CHALLENGE.test(title) ? 'challenge' : BRAND.test(title) ? 'widget' : null
}

function shown(tree: DesktopTree, element: DesktopTreeElement, bounds: DesktopBounds | null): boolean {
  const frame = element.frame
  if (frame === null || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) return false
  if (bounds !== null && !(frame.x < bounds.x + bounds.width && frame.x + frame.width > bounds.x && frame.y < bounds.y + bounds.height && frame.y + frame.height > bounds.y)) return false
  return clippedWords(tree, element, bounds) === null
}

export function treeSight(tree: DesktopTree, bounds: DesktopBounds | null = null): CaptchaSight {
  let sight: CaptchaSight = null
  for (const element of tree.elements) {
    const text = `${element.role} ${element.title ?? ''} ${element.value ?? ''}`
    if (CHALLENGE.test(text) && shown(tree, element, bounds)) return 'challenge'
    if (sight === null && !TAB_STRIP_TAB.test(element.role) && BRAND.test(text)) sight = 'widget'
  }
  return sight
}

export function captchaNote(sight: CaptchaSight, granted = false): string {
  if (sight === 'challenge') return granted ? CAPTCHA_GRANTED_NOTE : CAPTCHA_CHALLENGE_NOTE
  return sight === 'widget' ? CAPTCHA_WIDGET_NOTE : ''
}
