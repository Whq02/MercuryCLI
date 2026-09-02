
import { stringWidth } from '../../ink/stringWidth.js'
import { packHints } from './geometry.js'

const CLOSE_HINT_RE =
  /(?:\besc\b|←)[^·]*\b(?:close|cancel|keep|dismiss|back|exit|quit|later|clears?)\b/i

export function footerAdvertisesClose(footer: string): boolean {
  return CLOSE_HINT_RE.test(footer)
}

export function composeFooterHint(
  base: string,
  opts: { closeKeys: 'esc-arrow' | 'esc'; captureInput: boolean },
): string {
  if (footerAdvertisesClose(base)) return base
  const tail =
    opts.closeKeys !== 'esc' && opts.captureInput
      ? ' · esc / ← close'
      : ' · esc close'
  return base + tail
}

const CLOSE_VERB_RE = /\b(close|cancel|keep|dismiss|back|exit|quit|later|clears?)\b/i

function closeProjection(seg: string, budget: number): string {
  const key = /\besc\b/i.test(seg) ? 'esc' : '←'
  const verb = seg.match(CLOSE_VERB_RE)?.[0]
  const ladder = [seg]
  if (verb) ladder.push(`${key} ${verb.toLowerCase()}`)
  ladder.push(key)
  for (const rung of ladder) {
    if (stringWidth(rung) <= budget) return rung
  }
  return ''
}

export function packFooter(footer: string, budget: number): string {
  const segs = footer
    .split(' · ')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (segs.length === 0 || budget <= 0) return ''
  const closeIdx = segs.findIndex(s => CLOSE_HINT_RE.test(s))
  if (closeIdx < 0) return packHints(segs, budget)
  const close = closeProjection(segs[closeIdx]!, budget)
  if (close.length === 0) return ''
  const rest = segs.filter((_, i) => i !== closeIdx)
  if (rest.length === 0) return close
  const sepW = stringWidth(' · ')
  const packed = packHints(rest, Math.max(0, budget - stringWidth(close) - sepW))
  return packed.length > 0 ? `${packed} · ${close}` : close
}
