
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
}

const MAX_CODE_POINT = 0x10ffff

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    const lowered = body.toLowerCase()
    if (lowered.startsWith('#x')) {
      const code = Number.parseInt(lowered.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : whole
    }
    if (lowered.startsWith('#')) {
      const code = Number.parseInt(lowered.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[lowered] ?? whole
  })
}

export function htmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  if (!match) return undefined
  return decodeHtmlEntities(match[1] ?? match[2] ?? '')
}
