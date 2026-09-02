#!/usr/bin/env bun
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanEvolutionLedgers } from '../../src/utils/evolution/ledgerScan.js'

let fail = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const root = mkdtempSync(join(tmpdir(), 'ledger-scan-'))
try {
  const repoDir = join(root, 'repo-evolution')
  mkdirSync(repoDir, { recursive: true })
  const row = (program: string, subject: string, outcome: string, ts: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ts, program, subject, outcome, ...extra })
  writeFileSync(
    join(repoDir, 'merged-abc123.jsonl'),
    [
      row('prog-a', 's1', 'baseline', '2026-07-01T10:00:00.000Z', { iteration: 0, score: { dev: 1, unit: 'checks' } }),
      'NOT JSON {{{',
      row('prog-a', 's1', 'improved', '2026-07-02T10:00:00.000Z', { iteration: 1, score: { dev: 3, unit: 'checks' }, evidenceRefs: ['gate.log'] }),
      row('prog-b', 's2', 'refused', '2026-07-03T10:00:00.000Z'),
    ].join('\n') + '\n',
  )
  writeFileSync(
    join(repoDir, 'cards-def456.jsonl'),
    [
      row('memdir-cards', 'class-x', 'accepted', '2026-06-30T10:00:00.000Z', { mechanism: 'distill' }),
      row('memdir-cards', 'class-x', 'refused', '2026-07-01T11:00:00.000Z', { mechanism: 'distill' }),
    ].join('\n') + '\n',
  )

  writeFileSync(join(repoDir, 'garbage-only-fff000.jsonl'), 'NOT JSON {{{\nstill not json\n')
  writeFileSync(join(repoDir, 'empty-000fff.jsonl'), '')
  const asRoot = process.getuid?.() === 0
  if (!asRoot) {
    writeFileSync(join(repoDir, 'locked-abcdef.jsonl'), row('prog-locked', 's', 'accepted', '2026-07-01T00:00:00.000Z') + '\n')
    chmodSync(join(repoDir, 'locked-abcdef.jsonl'), 0)
  }

  const out = await scanEvolutionLedgers([
    { label: 'repo', dir: repoDir },
    { label: 'memdir', dir: join(root, 'DOES-NOT-EXIST') },
  ])

  check('3 programs from 2 files (row-field grouping)', out.length === 3, out.map(l => l.program).join(','))
  check('missing home = honest absence', out.every(l => l.source === 'repo'))
  check('result is still a plain array (backward compat)', Array.isArray(out))
  const expectedUnreadable = asRoot ? 1 : 2
  check(
    `unreadableFiles counts garbage-only${asRoot ? '' : ' + unreadable'} but NOT the empty file`,
    out.unreadableFiles === expectedUnreadable,
    `unreadableFiles=${out.unreadableFiles} expected=${expectedUnreadable}`,
  )
  const a = out.find(l => l.program === 'prog-a')
  check('garbage line skipped, valid rows kept', a?.rows.length === 2)
  check('frontier best from the pure rollup', a?.summary.frontier.best?.score === 3 && a?.summary.frontier.dryIterations === 0)
  const cards = out.find(l => l.program === 'memdir-cards')
  check(
    'drift arithmetic present (accept-rate over class-x)',
    cards?.drift[0]?.subject === 'class-x' && cards?.drift[0]?.acceptRate === 0.5,
    JSON.stringify(cards?.drift[0] ?? null),
  )
  check('most-recently-active first', out[0]?.program === 'prog-b', out[0]?.program)

  const dist = readFileSync(join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs'), 'utf8')
  check(
    '/ledger ships in dist',
    dist.includes('"ledger"') && dist.includes('Evolution ledger'),
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(fail === 0 ? '✅ prove-ledger-scan GREEN' : '❌ prove-ledger-scan RED')
process.exit(fail)
