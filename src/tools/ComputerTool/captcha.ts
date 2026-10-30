import type { DesktopTree } from '../../services/desktop/driver.js'

export const CAPTCHA_HANDOFF = 'captcha refused: a human-verification challenge is visible — the operator must complete it; nothing done, do not try to solve it'
const CHALLENGE = /verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|verify\s+you\s+are\s+not\s+a\s+robot|i(?:['’]m|\s+am)\s+not\s+a\s+robot|i\s+am\s+human|are\s+you\s+a\s+robot|select\s+all\s+(?:the\s+)?(?:images|squares)/i
const BRAND = /\b(?:re[ -]?captcha|h[ -]?captcha|turnstile|captcha)\b/i
const ATTRIBUTION = /protected\s+by/i

export function namesCaptcha(text: string): boolean {
  return CHALLENGE.test(text) || BRAND.test(text)
}

export function treeNamesCaptcha(tree: DesktopTree): boolean {
  const texts = tree.elements.map(element => `${element.role} ${element.title ?? ''} ${element.value ?? ''}`)
  if (texts.some(text => CHALLENGE.test(text))) return true
  if (!texts.some(text => BRAND.test(text))) return false
  return !texts.some(text => ATTRIBUTION.test(text))
}
