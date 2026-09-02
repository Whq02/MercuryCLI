#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/prove-attention-focus.ts — UI half:
//  focus follows STABLE IDENTITY through regrouping, and the sort never rides
//  recency.
//
//  A regression pin (born green by design — the mechanics landed red-ritualed
//  across prove-attention-fold §7 and the A2 board work): the law holds
//  because (a) the board keys attention rows by SUBJECT, bucket-free, so a
//  bucket move keeps the key; (b) NavigablePanes follows the selection BY KEY
//  across re-renders with the clamped index as the disappearing-row
//  nearest-neighbour fallback; (c) sortAttention orders by urgency →
//  sinceMs → subjectId and never reads atMs (recency is display data).
//  If any half drifts, this exits 3 and loses its floor.
// ============================================================================
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const panes = readFileSync('src/components/mercury-ui/NavigablePanes.tsx', 'utf8')

t.section('RV-04 — stable identity, key-followed focus, recency-free sort')
// The attention view's board surface (the WORK/workbench board) was retired
// in place; the row-identity
// law lives on in the shell every board rides (NavigablePanes) and in the
// contracts' sort — the checks below are those halves.
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
  /clamped index/.test(panes),
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
