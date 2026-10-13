import { htmlToText, readAttribute } from '../../services/search/htmlText.js'

export const PAYWALL_MESSAGE = 'this page is paywalled; search for another source — do not retry this URL'

export function pageAccessNotice(html: string): string | undefined {
  const gated = [...html.matchAll(/<(?:div|section|aside|dialog)\b([^>]*)>/gi)].some(match => {
    const names = `${readAttribute(match[1]!, 'id') ?? ''} ${readAttribute(match[1]!, 'class') ?? ''}`
    return /(?:^|[\s_-])paywall(?:$|[\s_-])/i.test(names)
  })
  if (gated && /subscribe\s+to\s+(?:continue|read)|subscription\s+required|already\s+a\s+subscriber/i.test(htmlToText(html))) return PAYWALL_MESSAGE
  const pending: unknown[] = []
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (readAttribute(match[1]!, 'type') !== 'application/ld+json') continue
    try { pending.push(JSON.parse(match[2]!)) } catch {}
  }
  while (pending.length) {
    const node = pending.pop()
    if (Array.isArray(node)) { pending.push(...node); continue }
    if (node === null || typeof node !== 'object') continue
    const object = node as Record<string, unknown>
    const types = Array.isArray(object['@type']) ? object['@type'] : [object['@type']]
    if ((object.isAccessibleForFree === false || object.isAccessibleForFree === 'false') && types.some(type => typeof type === 'string' && /^(?:NewsArticle|Article|BlogPosting|CreativeWork|WebPage)$/.test(type))) return PAYWALL_MESSAGE
    if (object['@graph']) pending.push(object['@graph'])
  }
  if (/\b(?:id|class)\s*=\s*["'][^"']*(?:cf-chl|cf-challenge|g-recaptcha|h-captcha)/i.test(html)) {
    return 'This page requires a browser challenge; search for another source — do not retry this URL.'
  }
  return undefined
}
