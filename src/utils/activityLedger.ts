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
//  the config store's deferred road (the cache now, one publish folded into
//  the next save or at exit); no synchronous durable work in any hot phase,
//  no per-turn writes, never an unbounded file.
// ============================================================================

import { getGlobalConfig, saveGlobalConfigDeferred } from './config/globalConfig.js'

export type HeadlessActivityKind = 'print' | 'sdk' | `verb:${string}`

export interface HeadlessActivity {
  print: number
  sdk: number
  verbs: Record<string, number>
  lastKind: string
  lastAt: number
}

const EMPTY: HeadlessActivity = { print: 0, sdk: 0, verbs: {}, lastKind: '', lastAt: 0 }

/** Note one headless activity. One bounded merge into the config CACHE; the
 *  deferred road carries durability — folded into the next save of any
 *  kind, or published at process exit by the deferred writer's own exit
 *  flush. Never a hot-path write: the synchronous saver here was a locked,
 *  backed-up, fsync'd rewrite of the global file in front of every headless
 *  boot's first turn — and every concourse worker is a headless boot, so a
 *  batch of worker boots contended for the one config lock before any of
 *  them worked. */
export function noteHeadlessActivity(kind: HeadlessActivityKind): void {
  try {
    saveGlobalConfigDeferred(current => {
      const prev = (current.headlessActivity as HeadlessActivity | undefined) ?? EMPTY
      const next: HeadlessActivity = {
        print: prev.print + (kind === 'print' ? 1 : 0),
        sdk: prev.sdk + (kind === 'sdk' ? 1 : 0),
        // A row persisted before the verbs map existed carries none: the
        // stamp starts the map instead of throwing into the fail-soft catch.
        verbs: kind.startsWith('verb:')
          ? { ...(prev.verbs ?? {}), [kind.slice(5)]: (prev.verbs?.[kind.slice(5)] ?? 0) + 1 }
          : (prev.verbs ?? {}),
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
