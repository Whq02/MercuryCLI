#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-durability/prove-receipt-contract.ts — action-interface: ONE
//  receipt schema for every mutation.
//
//  scripts/project-services/prove-change-receipts.ts already proves the RING: what a
//  mutation mints, what a read does not, ordering, retention, isolation, the
//  cancellation law, and one end-to-end edit through the production
//  transaction. It does not pin the property the acceptance measure is
//  actually about, which is SINGULARITY — that there is one schema and one
//  minting path, not a second ledger drifting beside the first. receipts.ts
//  says so in its own header ("no second observation path, no duplicate
//  ledger"); nothing enforced it.
//
//    §1  ONE SCHEMA — the version, the receipt-shape predicate and the
//        mutation vocabulary are each defined exactly once.
//    §2  ONE MINT — only the receipt owner constructs receipts. The terminal
//        seam has several legitimate consumers (auto-capture, counsel,
//        repetition policy, the run coordinator) reading the SAME chokepoint
//        for their own purposes, which is the design; they are pinned by name
//        so a new subscriber is a deliberate act rather than a silent second
//        ledger. Fails in both directions.
//    §3  THE BELT — an effect that changed paths mints a receipt even when
//        its operation is not in the mutation vocabulary. This is what makes
//        the vocabulary a supplement rather than a coverage risk: a new
//        mutating tool that forgets to register its prefix still gets a
//        receipt, and the ONLY way to mutate silently is to change paths and
//        report none. Asserted behaviourally, not by reading the table.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from './harness.ts'

const t = checker()

const contracts = await import('../../src/services/changeTransaction/contracts.ts')

/** Every .ts/.tsx under src/, for the single-definition scans. */
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
  // Legitimate readers of the terminal chokepoint. Only the first MINTS
  // receipts; the rest observe the same event for their own owners, which is
  // exactly the "one observation path" the design wants.
  const PINNED = [
    'src/services/changeTransaction/receipts.ts', // the ONE minter
    'src/services/changeTransaction/repetitionPolicy.ts', // repetition detection
    'src/services/ide/txAutoCapture.ts', // IDE transaction auto-capture
    'src/services/counsel/counsel.ts', // counsel's advisory read
    'src/services/run/runCoordinator.ts', // run kernel effect fold
    'src/memdir/mnemeObserveTurn.ts', // memory observation — reads turns, mints nothing
  ]
  const consumers = grepFiles(/subscribeToolTerminal/).filter(
    f => f !== 'src/services/run/effectObserver.ts', // the seam itself
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

  // The minting call itself lives in exactly one module.
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
