// ============================================================================
//  footerHint — compose the CommandCenter footer's close-key advertisement +
//  the ONE-LINE packing law.
//
//  CommandCenter auto-appends a close hint to whatever the footer prop says. But
//  several captureInput=false surfaces bake their OWN close synonym into the
//  footer ('esc close' / 'esc dismiss' / 'esc keep' / 'esc cancel' / 'esc / ←
//  close'); appending on top of those produced a doubled/contradictory tail
// So the append fires ONLY when the footer doesn't already
//  advertise a close action. A footer with no close token is byte-identical to
//  the pre-fix behavior.
//
// packFooter applies the one-line law at the SHELL chokepoint: complete
//  segments only, greedy in display order, never a dangling separator — and
//  the CLOSE segment is RESERVED (the one hint that must survive any width,
//  because the key always works).
// ============================================================================

import { stringWidth } from '../../ink/stringWidth.js'
import { packHints } from './geometry.js'

// An `esc`/`←` token followed (within the same `·`-delimited segment) by a
// close-action word. Scoped with [^·]* so a later segment's word can't match a
// stray earlier `esc`. `later` is the close synonym for DEFER-shaped surfaces
// (the party consent card: esc parks the asks — its footer must speak the
// same word as its [later] verb, not a contradictory 'close'). `clear(s)` is
// the synonym for FILTER-shaped surfaces (the memory centre, the /manager
// search: the first esc clears the query, the next one closes — the footer
// must speak 'clear', never a doubled/contradictory 'esc close' tail).
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

// The verb word CLOSE_HINT_RE recognizes — reused to build the projection
// ladder below from the AUTHORED segment (never a second vocabulary).
const CLOSE_VERB_RE = /\b(close|cancel|keep|dismiss|back|exit|quit|later|clears?)\b/i

/** The shortest TRUTHFUL projection of an authored close segment that fits
 *  `budget` (MINI-TEMPER item 3): the authored segment first, then the
 *  primary key + its own verb ('esc close'), then the bare key ('esc' / '←')
 *  — the key always works, so every rung stays true — and '' when even the
 *  bare key exceeds the physical width. Never returns an over-budget string. */
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

/** The one-line footer law: pack '·'-delimited segments greedily (display
 *  order = priority order), PREFERRING the CLOSE segment (it packs first, at
 *  its shortest truthful projection when narrow). Physical width is the
 *  ABSOLUTE bound: stringWidth(result) never exceeds the budget for ANY
 *  non-negative budget — a footer can shrink to 'esc', or to '', but it can
 *  never claim cells the terminal lacks. Never ends with a dangling
 *  separator. */
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
