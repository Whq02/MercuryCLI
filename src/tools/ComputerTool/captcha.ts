import type { DesktopTree } from '../../services/desktop/driver.js'

export const CAPTCHA_HANDOFF = 'captcha refused: a human-verification challenge is visible — the operator must complete it; nothing done, do not try to solve it'
const CHALLENGE = /\b(?:re[ -]?captcha|h[ -]?captcha|turnstile|captcha)\b|verify\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human|i(?:['’]m|\s+am)\s+not\s+a\s+robot/i

export function namesCaptcha(text: string): boolean {
  return CHALLENGE.test(text)
}

export function treeNamesCaptcha(tree: DesktopTree): boolean {
  return tree.elements.some(element => namesCaptcha(`${element.role} ${element.title ?? ''} ${element.value ?? ''}`))
}
