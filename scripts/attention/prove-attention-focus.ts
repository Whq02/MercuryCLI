#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const panes = readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8')

t.section('RV-04 — stable identity, key-followed focus, recency-free sort')
t.check(
  'the prompts panel keys its rows by record identity (prompt:<uuid>), never by index',
  readFileSync('src/components/prompts-panel/rows.ts', 'utf8').includes('key: `prompt:${m.uuid}`'),
)
t.check(
  'NavigablePanes follows the selection BY KEY across re-renders',
  panes.includes('rowKey(r) === selKeyRef.current'),
)
t.check(
  'the disappearing-row fallback is the clamped index (nearest neighbour)',
  panes.includes('let sel = Math.min(nav.sel, Math.max(0, sectionRows.length - 1))') && panes.includes('if (followed >= 0) sel = followed'),
)
{
  const contracts = readFileSync('src/services/attention/contracts.ts', 'utf8')
  const sortFn = contracts.slice(contracts.indexOf('export function sortAttention'))
  const body = sortFn.slice(0, sortFn.indexOf('\n}'))
  t.check(
    'sortAttention never reads atMs (recency is display data, not order)',
    !body.includes('atMs'),
  )
  t.check(
    'sortAttention orders urgency → sinceMs → subjectId',
    body.indexOf('urgency') !== -1 && body.indexOf('urgency') < body.indexOf('sinceMs') && body.indexOf('sinceMs') !== -1 && body.indexOf('sinceMs') < body.indexOf('subjectId'),
  )
}

t.finish('prove-attention-focus')
