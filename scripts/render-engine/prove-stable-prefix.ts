#!/usr/bin/env bun
// prove-stable-prefix — spec 02's discipline for streamed bodies.
//
//  The boundary contract: a safe cut is a position where the host renderer
//  satisfies render(prefix) ++ render(tail) === render(whole) — a compliant
//  renderer treats a trailing newline as a line terminator. The engine's
//  BlankLineBoundary claims cuts only after blank lines outside fences; any
//  doubt means no cut and the tail renders whole (conservative, correct).
//
//   §1 O(delta) on boundary-rich prose: characters handed to the renderer
//      stay near body length — never the quadratic full-body re-render.
//   §2 prefix rows never re-derive: promoted rows persist verbatim.
//   §3 equality at EVERY flush on the adversarial fence stream (a fence
//      opening in one chunk, closing 40 chunks later): inside the fence no
//      cut is claimed, and the cached rows equal the uncached render at
//      every intermediate state.
//   §4 the cache drops on width change and on a non-extension (rewrite).
//   §5 an open fence disqualifies cuts until it closes.

import { StreamBodyCache } from '../../src/render-engine/stablePrefix.js'
import { check, finish, section } from './harness.js'

/** A seam-compliant toy renderer: lines split on '\n' with the trailing
 *  terminator dropped, each line hard-wrapped to width. */
const makeRenderer = (): { render: (t: string, w: number) => string[]; count: () => number } => {
  let chars = 0
  return {
    render: (text: string, width: number): string[] => {
      chars += text.length
      const lines = text.split('\n')
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      const out: string[] = []
      for (const line of lines) {
        for (let i = 0; i < Math.max(1, Math.ceil(line.length / width)); i++) {
          out.push(line.slice(i * width, (i + 1) * width))
        }
      }
      return out
    },
    count: () => chars,
  }
}

section('§1 O(delta) on boundary-rich prose')
{
  const counted = makeRenderer()
  const cache = new StreamBodyCache(counted.render)
  const control = makeRenderer()
  let body = ''
  let allEqual = true
  for (let i = 0; i < 120; i++) {
    body += `paragraph ${i} with words. `
    if (i % 3 === 2) body += '\n\n'
    const cached = cache.update(body, 40).rows.join('|')
    const full = control.render(body, 40).join('|')
    if (cached !== full) {
      allEqual = false
      console.log(`    flush ${i}:\n      cached ${cached.slice(-90)}\n      full   ${full.slice(-90)}`)
      break
    }
  }
  check('cached rows equal the uncached render at every flush', allEqual)
  const cachedChars = counted.count()
  const naiveChars = control.count()
  check(
    `O(delta): ${cachedChars} chars rendered vs ${naiveChars} naive (${(naiveChars / cachedChars).toFixed(1)}× win)`,
    cachedChars < naiveChars / 5 && cachedChars < body.length * 4,
  )
  check('promotions happened (the cache is live)', cache.prefixPromotions() > 10)
}

section('§2 prefix rows never re-derive')
{
  const cache = new StreamBodyCache(makeRenderer().render)
  const r1 = cache.update('alpha\n\nbeta', 40)
  const stable1 = r1.rows.slice(0, r1.stableRows)
  const r2 = cache.update('alpha\n\nbeta gamma', 40)
  const stable2 = r2.rows.slice(0, r2.stableRows)
  check('the promoted prefix rows persist verbatim', stable2.join('|') === stable1.join('|') && stable1.length > 0)
}

section('§3 flush-for-flush equality across the fence stream')
{
  const CHUNKS: string[] = []
  for (let i = 0; i < 12; i++) CHUNKS.push(`para ${i} word word.\n\n`)
  CHUNKS.push('```\n')
  for (let i = 0; i < 40; i++) CHUNKS.push(`code line ${i}\n`)
  CHUNKS.push('```\n')
  CHUNKS.push('\n')
  for (let i = 0; i < 12; i++) CHUNKS.push(`tail ${i} word.\n\n`)
  CHUNKS.push('final paragraph.')

  const counted = makeRenderer()
  const cache = new StreamBodyCache(counted.render)
  const control = makeRenderer()
  let body = ''
  let allEqual = true
  let promoteInsideFence = false
  let fenceOpenAt = -1
  let fenceCloseAt = -1
  let promosAtOpen = 0
  for (const [idx, chunk] of CHUNKS.entries()) {
    body += chunk
    if (chunk === '```\n' && fenceOpenAt === -1) {
      fenceOpenAt = idx
      promosAtOpen = cache.prefixPromotions()
    } else if (chunk === '```\n') {
      fenceCloseAt = idx
    }
    const cached = cache.update(body, 40).rows.join('|')
    const full = control.render(body, 40).join('|')
    if (cached !== full) {
      allEqual = false
      console.log(`    flush ${idx}: divergence`)
      break
    }
    if (fenceOpenAt !== -1 && fenceCloseAt === -1 && idx > fenceOpenAt) {
      // Between open and close: the fence's own cut (before it opened) may
      // land, but nothing INSIDE the fence may promote past the opener.
      if (cache.prefixPromotions() > promosAtOpen + 1) promoteInsideFence = true
    }
  }
  check('cached rows equal the uncached render at every flush (fence included)', allEqual)
  check('no promotion lands inside the open fence', !promoteInsideFence)
  check('the fence close re-enables promotion', cache.prefixPromotions() > promosAtOpen + 1)
}

section('§4 drops: width change and non-extension')
{
  const counted = makeRenderer()
  const cache = new StreamBodyCache(counted.render)
  cache.update('one\n\ntwo\n\nthree', 40)
  const beforeDrop = counted.count()
  const atNewWidth = cache.update('one\n\ntwo\n\nthree', 20)
  check(
    'a width change drops the cache (full re-render at the new width)',
    counted.count() - beforeDrop >= 'one\n\ntwo\n\nthree'.length &&
      atNewWidth.rows.join('|') === makeRenderer().render('one\n\ntwo\n\nthree', 20).join('|'),
  )
  const rewritten = cache.update('completely different text', 20)
  check(
    'a non-extension (rewrite) drops and renders exactly the new body',
    rewritten.rows.join('|') === makeRenderer().render('completely different text', 20).join('|'),
  )
}

section('§5 an open fence disqualifies cuts')
{
  const cache = new StreamBodyCache(makeRenderer().render)
  const open = 'text\n\n```\ncode so far\n\n\nmore code\n'
  cache.update(open, 40)
  const promoted = cache.prefixPromotions()
  check('only the pre-fence cut promoted', promoted <= 1)
  cache.update(open + 'still inside the fence\n\n', 40)
  check('still no new promotion while the fence stays open', cache.prefixPromotions() === promoted)
  cache.update(open + 'still inside the fence\n```\n\nafter the fence\n\n', 40)
  check('the close re-enables promotion', cache.prefixPromotions() > promoted)
}

finish()
