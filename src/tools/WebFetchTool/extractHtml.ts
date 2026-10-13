import { htmlToText, readAttribute } from '../../services/search/htmlText.js'

type Block = {
  tag: string
  open: string
  close: string
  parts: (Block | string)[]
  parent?: Block
  dropped: boolean
  text: number
  links: number
  markup: number
}

const OMIT = new Set(['head', 'script', 'style', 'noscript', 'template', 'nav', 'footer', 'aside', 'form', 'svg'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const CONTAINERS = new Set(['body', 'main', 'article', 'section', 'div', 'td'])

function unwanted(tag: string, attributes: string): boolean {
  if (OMIT.has(tag) || /\bhidden(?:\s|=|>|$)/i.test(attributes)) return true
  if (readAttribute(attributes, 'aria-hidden') === 'true') return true
  if (/^(navigation|banner|contentinfo|dialog)$/.test(readAttribute(attributes, 'role') ?? '')) return true
  const names = `${readAttribute(attributes, 'id') ?? ''} ${readAttribute(attributes, 'class') ?? ''}`
  return /(?:^|[\s_-])(?:nav|navbar|sidebar|footer|cookie|consent|advertisement|ads)(?:$|[\s_-])/i.test(names)
}

export function extractMainHtml(source: string): { html: string; textLength: number; density: number; sparse: boolean } {
  const clean = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const root: Block = { tag: 'body', open: '', close: '', parts: [], dropped: false, text: 0, links: 0, markup: 0 }
  const nodes = [root]
  const stack = [root]
  for (const token of clean.matchAll(/<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+|</g)) {
    const raw = token[0]
    const current = stack[stack.length - 1]!
    const closing = /^<\/([\w:-]+)/.exec(raw)
    if (closing) {
      const tag = closing[1]!.toLowerCase()
      const index = stack.findLastIndex(node => node.tag === tag)
      if (index > 0) {
        stack[index]!.close = raw
        stack.length = index
      }
      continue
    }
    const opening = /^<([\w:-]+)([\s\S]*)>$/.exec(raw)
    if (!opening) {
      if (!current.dropped) current.parts.push(raw)
      continue
    }
    const tag = opening[1]!.toLowerCase()
    const node: Block = { tag, open: raw, close: '', parts: [], parent: current, dropped: current.dropped || unwanted(tag, opening[2]!), text: 0, links: 0, markup: raw.length }
    current.parts.push(node)
    nodes.push(node)
    if (!VOID.has(tag) && !raw.endsWith('/>')) stack.push(node)
  }
  for (const node of [...nodes].reverse()) {
    if (node.dropped) continue
    node.markup += node.close.length
    for (const part of node.parts) {
      if (typeof part === 'string') node.text += htmlToText(part).length
      else if (!part.dropped) {
        node.text += part.text
        node.links += part.links
        node.markup += part.markup
      }
    }
    if (node.tag === 'a') node.links = node.text
  }
  const body = nodes.find(node => node.tag === 'body' && node !== root) ?? root
  const density = (node: Block) => Math.max(0, node.text - node.links) / Math.max(1, node.text + node.markup)
  const candidates = nodes.filter(node => !node.dropped && CONTAINERS.has(node.tag) && node.text >= 120 && node.links < node.text / 2)
  let best = candidates.reduce((a, b) => density(b) > density(a) ? b : a, body)
  for (let parent = best; parent; parent = parent.parent!) {
    if (parent.tag === 'article' || parent.tag === 'main') {
      best = parent
      break
    }
  }
  const selected = best.tag === 'main' || best.tag === 'article' || best === body
    ? [best]
    : (best.parent?.parts ?? [best]).filter(part => typeof part === 'string' || (!part.dropped && (part.links < Math.max(1, part.text / 2) || part === best)))
  const render = (part: Block | string): string => typeof part === 'string' ? part : part.dropped ? '' : part.open + part.parts.map(render).join('') + part.close
  const html = selected.map(render).join('')
  const textLength = body.text
  const bodyDensity = textLength / Math.max(1, clean.length)
  const scriptRoot = /\bid\s*=\s*["'](?:root|app|__next|__nuxt)["']/i.test(clean)
  const sparse = /<script\b/i.test(source) && (textLength < 80 || (textLength < 300 && (scriptRoot || bodyDensity < 0.1)))
  return { html, textLength, density: bodyDensity, sparse }
}
