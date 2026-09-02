#!/usr/bin/env bun
// prove-freshness.ts — locks the shared "↻ Ns ago" freshness math
// (utils/cockpit/freshness.ts, the trust-cockpit program): unit ladder,
// honest edges (unset stamp ⇒ `↻ —`, future stamp ⇒ clock-skew `just now`),
// and the stale-tone threshold every adopting surface (trace/monitor/cockpit/
// daemon/ledger) keys AMBER off.

import { formatFreshness, freshnessTone } from '../../src/utils/cockpit/freshness.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const NOW = 1_000_000_000_000

// 1) Unit ladder: s → m → h → d, floor semantics at each boundary.
const cases: Array<[number, string]> = [
  [0, '↻ 0s ago'],
  [999, '↻ 0s ago'],
  [1_000, '↻ 1s ago'],
  [59_999, '↻ 59s ago'],
  [60_000, '↻ 1m ago'],
  [59 * 60_000 + 59_000, '↻ 59m ago'],
  [3_600_000, '↻ 1h ago'],
  [47 * 3_600_000, '↻ 47h ago'],
  [48 * 3_600_000, '↻ 2d ago'],
  [10 * 24 * 3_600_000, '↻ 10d ago'],
]
for (const [delta, want] of cases) {
  const got = formatFreshness(NOW, NOW - delta)
  t(`Δ${delta}ms ⇒ "${want}"`, got === want, got)
}

// 2) Honest edges: never fabricate an age.
t('unset stamp (0) ⇒ "↻ —"', formatFreshness(NOW, 0) === '↻ —')
t('negative stamp ⇒ "↻ —"', formatFreshness(NOW, -5) === '↻ —')
t(
  'future stamp ⇒ clock-skew "↻ just now"',
  formatFreshness(NOW, NOW + 5_000) === '↻ just now',
)

// 3) Stale tone: strictly-older-than threshold; unset stamp stays fresh-toned
//    (the label already reads `↻ —` — no double alarm).
t('fresh at exactly staleMs', freshnessTone(NOW, NOW - 60_000, 60_000) === 'fresh')
t('stale past staleMs', freshnessTone(NOW, NOW - 60_001, 60_000) === 'stale')
t('fresh when recent', freshnessTone(NOW, NOW - 1_000, 60_000) === 'fresh')
t('unset stamp ⇒ fresh tone', freshnessTone(NOW, 0, 60_000) === 'fresh')
t('future stamp ⇒ fresh tone', freshnessTone(NOW, NOW + 5_000, 60_000) === 'fresh')

process.exit(fail)
