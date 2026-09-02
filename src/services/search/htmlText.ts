// ============================================================================
//  services/search/htmlText — the few HTML-text operations the search
//  parsers need (entity decoding, tag stripping, one attribute read). A
//  full HTML parser is not a dependency the search estate wants to carry
//  for two page shapes; these are total over any string.
// ============================================================================

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

/** The last Unicode code point — String.fromCodePoint THROWS above it, so
 *  totality requires the clamp: a numeric entity beyond the range stays as
 *  written, exactly like an unknown named entity (a poisoned
 *  page carrying `&#x110000;` must be a parsed page, never an untyped
 *  RangeError out of the door). */
const MAX_CODE_POINT = 0x10ffff

/** Decode the named entities the page shapes use plus every numeric form;
 *  an unknown named entity — or a numeric entity outside the Unicode
 *  range — stays as written (never dropped, never thrown). */
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

/** Tags out, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** One attribute's value from an opening tag's attribute string (either
 *  quote style, any order); undefined when absent. */
export function readAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  if (!match) return undefined
  return decodeHtmlEntities(match[1] ?? match[2] ?? '')
}
