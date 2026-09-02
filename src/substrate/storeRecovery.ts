/**
 * storeRecovery — quarantine + recovery evidence for damaged stores (the
 * crash-consistency program).
 *
 * The FC5 rule: a mutation must NEVER silently proceed from `empty()` over
 * the only damaged copy of a store. Before the kernel lets a declared
 * fail-open store mutate past unreadable bytes, the bytes are PRESERVED
 * under a bounded, clearly-named quarantine copy beside the store, and the
 * recovery is recorded in an append-only ledger the doctor/UI surface.
 * Never throws — preservation is best-effort but the ATTEMPT is mandatory
 * and the ledger row records whether it succeeded.
 */

import { appendFile, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'

/** Quarantine copies kept per store path (oldest pruned beyond this). */
const MAX_QUARANTINE_COPIES = 3

/** Ledger rows kept (read path tails; writer trims opportunistically). */
const MAX_LEDGER_ROWS = 500

export interface StoreRecoveryEvent {
  ts: string
  store: string
  path: string
  reason: string
  /** The quarantine copy holding the damaged bytes (null: preservation
   *  itself failed — recorded honestly, never silently). */
  quarantinePath: string | null
  /** How the mutation proceeded: from the runtime's last known committed
   *  value, or from the declared empty(). */
  resumedFrom: 'last-good' | 'empty'
  /** Event class. Absent decodes as 'quarantine'. A
   *  'read-degrade' row records a fail-open READ that degraded to empty()
   *  — the damaged bytes stay in place on disk (no republish happened), so
   *  there is no quarantine copy; the next mutation quarantines them
   * */
  kind?: 'quarantine' | 'read-degrade'
}

export function storeRecoveryLedgerPath(): string {
  return join(getMercuryHome(), 'recovery', 'store-recovery.jsonl')
}

const quarantineName = (base: string): string =>
  `${base}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}.recovered`

/**
 * Preserve `rawBytes` (the damaged store content) beside the store, bounded
 * to {@link MAX_QUARANTINE_COPIES} copies, then record the event. Returns
 * the event as recorded.
 */
export async function quarantineDamagedStore(args: {
  store: string
  path: string
  rawBytes: string | null
  reason: string
  resumedFrom: 'last-good' | 'empty'
}): Promise<StoreRecoveryEvent> {
  const dir = dirname(args.path)
  const base = basename(args.path)
  let quarantinePath: string | null = null
  if (args.rawBytes !== null) {
    try {
      const target = join(dir, quarantineName(base))
      await writeFile(target, args.rawBytes, 'utf-8')
      quarantinePath = target
      // Bound: prune the oldest quarantine copies for THIS store past the cap.
      const siblings = (await readdir(dir))
        .filter(n => n.startsWith(`${base}.damaged-`) && n.endsWith('.recovered'))
        .sort()
      for (const old of siblings.slice(0, Math.max(0, siblings.length - MAX_QUARANTINE_COPIES))) {
        await unlink(join(dir, old)).catch(() => {})
      }
    } catch (e) {
      logForDebugging(`[${args.store}] quarantine write failed (recorded): ${e}`)
    }
  }
  const event: StoreRecoveryEvent = {
    ts: new Date().toISOString(),
    store: args.store,
    path: args.path,
    reason: args.reason.slice(0, 300),
    quarantinePath,
    resumedFrom: args.resumedFrom,
  }
  try {
    const ledger = storeRecoveryLedgerPath()
    mkdirSync(dirname(ledger), { recursive: true })
    await appendFile(ledger, JSON.stringify(event) + '\n', 'utf-8')
  } catch (e) {
    logForDebugging(`[${args.store}] recovery ledger append failed: ${e}`)
  }
  return event
}

/**
 * Record a fail-open READ that degraded to empty(). The
 * damaged file is untouched on disk — read is lock-free and must not race a
 * writer — so no bytes are copied; the event makes the degradation
 * OBSERVABLE (doctor's store-quarantines check reads this same ledger).
 * Callers latch per store per process: one row per incident, not per read.
 */
export async function recordStoreReadDegradation(args: {
  store: string
  path: string
  reason: string
}): Promise<void> {
  const event: StoreRecoveryEvent = {
    ts: new Date().toISOString(),
    store: args.store,
    path: args.path,
    reason: args.reason.slice(0, 300),
    quarantinePath: null,
    resumedFrom: 'empty',
    kind: 'read-degrade',
  }
  try {
    const ledger = storeRecoveryLedgerPath()
    mkdirSync(dirname(ledger), { recursive: true })
    await appendFile(ledger, JSON.stringify(event) + '\n', 'utf-8')
  } catch (e) {
    logForDebugging(`[${args.store}] read-degrade ledger append failed: ${e}`)
  }
}

/** Read the recovery ledger (bounded tail; malformed lines skipped). */
export async function readStoreRecoveryEvents(): Promise<StoreRecoveryEvent[]> {
  try {
    const text = await readFile(storeRecoveryLedgerPath(), 'utf-8')
    const out: StoreRecoveryEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e && typeof e === 'object' && typeof e.store === 'string') {
          out.push(e as StoreRecoveryEvent)
        }
      } catch {
        // skip garbage
      }
    }
    return out.slice(-MAX_LEDGER_ROWS)
  } catch {
    return []
  }
}
