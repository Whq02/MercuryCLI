// ============================================================================
//  activityLedger — headless activity made visible (.5.4;
//
//
//  `numStartups` keeps its exact semantics (INTERACTIVE boots — first-render
//  readers depend on it). Headless work was invisible beside it: a box that
//  ran 200 `-p` calls looked identical to one that never ran Mercury, so
//  wedge detection could not tell "no interactive boots" from "no activity".
//  This ledger is BOUNDED COUNTERS on the global config (entrypoint kind →
//  count, plus last-activity stamps) — one in-memory merge per boot riding
//  the config store's existing deferred flush; no synchronous durable work
//  in any hot phase, no per-turn writes, never an unbounded file.
// ============================================================================

import { getGlobalConfig, saveGlobalConfig } from './config/globalConfig.js'

export type HeadlessActivityKind = 'print' | 'sdk' | `verb:${string}`

export interface HeadlessActivity {
  print: number
  sdk: number
  verbs: Record<string, number>
  lastKind: string
  lastAt: number
}

const EMPTY: HeadlessActivity = { print: 0, sdk: 0, verbs: {}, lastKind: '', lastAt: 0 }

/** Note one headless activity. One bounded config merge; the store's
 *  deferred flush carries durability — never a hot-path write. */
export function noteHeadlessActivity(kind: HeadlessActivityKind): void {
  try {
    saveGlobalConfig(current => {
      const prev = (current.headlessActivity as HeadlessActivity | undefined) ?? EMPTY
      const next: HeadlessActivity = {
        print: prev.print + (kind === 'print' ? 1 : 0),
        sdk: prev.sdk + (kind === 'sdk' ? 1 : 0),
        verbs: kind.startsWith('verb:')
          ? { ...prev.verbs, [kind.slice(5)]: (prev.verbs[kind.slice(5)] ?? 0) + 1 }
          : prev.verbs,
        lastKind: kind,
        lastAt: Date.now(),
      }
      return { ...current, headlessActivity: next }
    })
  } catch {
    // Activity accounting must never break a boot.
  }
}

/** The visibility read (doctor row / diagnostics). */
export function getHeadlessActivity(): HeadlessActivity {
  try {
    return (getGlobalConfig().headlessActivity as HeadlessActivity | undefined) ?? EMPTY
  } catch {
    return EMPTY
  }
}
