#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from './harness.ts'

const t = checker()

const contracts = await import('../../src/services/changeTransaction/contracts.ts')

function srcFiles(dir = 'src'): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...srcFiles(p))
    else if (/\.tsx?$/.test(entry.name) && statSync(p).isFile()) out.push(p)
  }
  return out
}
const FILES = srcFiles()
const grepFiles = (re: RegExp): string[] =>
  FILES.filter(f => re.test(readFileSync(f, 'utf8'))).sort()

t.section('§1 — one schema')
{
  for (const [label, re] of [
    ['the contract version', /export const CHANGE_CONTRACT_VERSION\s*=/],
    ['the receipt-shape predicate', /export function isReceiptShaped\b/],
    ['the mutation vocabulary', /export function isMutationOperation\b/],
  ] as const) {
    const defs = grepFiles(re)
    t.check(
      `${label} is defined exactly once`,
      defs.length === 1,
      defs.join(', ') || 'NO definition found',
    )
  }
  t.check(
    'the single definition site is the contracts owner',
    grepFiles(/export const CHANGE_CONTRACT_VERSION\s*=/)[0] ===
      'src/services/changeTransaction/contracts.ts',
    grepFiles(/export const CHANGE_CONTRACT_VERSION\s*=/)[0] ?? '(none)',
  )
}

t.section('§2 — one mint, and the seam consumers are pinned')
{
  const PINNED = [
    'src/services/changeTransaction/receipts.ts',
    'src/services/changeTransaction/repetitionPolicy.ts',
    'src/services/ide/txAutoCapture.ts',
    'src/services/counsel/counsel.ts',
    'src/services/run/runCoordinator.ts',
    'src/memdir/mnemeObserveTurn.ts',
  ]
  const consumers = grepFiles(/subscribeToolTerminal/).filter(
    f => f !== 'src/services/run/effectObserver.ts',
  )
  for (const f of PINNED) {
    t.check(
      `pinned seam consumer still present: ${f}`,
      consumers.includes(f),
      consumers.includes(f) ? 'subscribes' : 'GONE — retire it from PINNED here',
    )
  }
  for (const f of consumers) {
    t.check(
      `no unpinned consumer of the terminal seam: ${f}`,
      PINNED.includes(f),
      PINNED.includes(f)
        ? 'pinned'
        : 'NEW — if it mints receipts that is a SECOND ledger; pin it here with a reason',
    )
  }

  const minters = grepFiles(/subscribeToolTerminal\(record\)/)
  t.check(
    'exactly one module wires the receipt recorder onto the seam',
    minters.length === 1 && minters[0] === 'src/services/changeTransaction/receipts.ts',
    minters.join(', ') || '(none)',
  )
}

t.section('§3 — the belt: changed paths mint regardless of the vocabulary')
{
  const effect = (operation: string, changedPaths: string[]) =>
    ({
      outcome: 'succeeded',
      operation,
      changedPaths,
      evidence: 'keel',
      startedAt: 1,
      completedAt: 2,
    }) as unknown as Parameters<typeof contracts.isReceiptShaped>[0]

  t.check(
    'a KNOWN mutation operation with no changed paths still mints',
    contracts.isReceiptShaped(effect('file.edit', [])),
  )
  t.check(
    'an UNKNOWN operation that changed paths still mints (the belt)',
    contracts.isReceiptShaped(effect('brand.new.tool.apply', ['/tmp/x.ts'])),
    'a new mutating tool that forgets its prefix must not mutate silently',
  )
  t.check(
    'a read operation that changed nothing mints nothing',
    !contracts.isReceiptShaped(effect('lsp.hover', [])),
  )
  t.check(
    'the vocabulary itself still classifies its declared prefixes',
    contracts.isMutationOperation('file.write') &&
      contracts.isMutationOperation('git.commit') &&
      !contracts.isMutationOperation('git.status'),
    'git.status is an observation and must never be a mutation',
  )
}

t.finish('prove-receipt-contract')
