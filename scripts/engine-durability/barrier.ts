// ============================================================================
//  scripts/engine-durability/barrier.ts — the CONTROLLED SCHEDULING SEAM for
//  durable-settlement reproducers.
//
//  Reproducing a write-ORDERING defect requires holding one publication at an
//  exact point while another runs to completion. A wall-clock sleep does not
//  qualify (it is a race, not a schedule) and the repo's own fault-injection
//  seam (MERCURY_FAULT_INJECT) can only throw or kill — it cannot hold.
//
//  So the hold is installed as a MODULE MOCK over the one durable publication
//  primitive, exactly the seam scripts/core-runtime/prove-runsurface-contract.ts
//  uses for src/query.ts. Consequences that matter:
//    · ZERO production edits — the reproducers pin the defect at the unmodified
//      tree, which is what "exits 1 before the fix" has to mean;
//    · the real durableAtomicPublish still performs every write, so the
//      fsync/rename/cleanup contract under test is the production one;
//    · the gate is per-PATH and single-claim, so a reproducer holds exactly the
//      publication it names and every other write proceeds untouched.
//
//  IMPORT THIS BEFORE ANY src IMPORT — the mock has to be registered before
//  runSidecar.ts binds durableAtomicPublish.
// ============================================================================

import { mock } from 'bun:test'

type PublishFn = (
  path: string,
  contents: string | Uint8Array,
  opts?: unknown,
) => Promise<void>

// Capture the real primitive BY REFERENCE before mock.module re-points the
// namespace binding — reading it back off the namespace at call time resolves
// to the mock and recurses.
const realNamespace = await import('../../src/substrate/durablePublish.ts')
const realExports = { ...realNamespace }
const realPublish = realNamespace.durableAtomicPublish as PublishFn

export interface PublishHold {
  /** Resolves with the held path once the publication has entered the gate. */
  readonly entered: Promise<string>
  /** Resolves once the released publication's real write has finished. */
  readonly settled: Promise<void>
  /** Let the held publication proceed. */
  release(): void
}

interface Hold {
  match: (path: string) => boolean
  claimed: boolean
  enter: (path: string) => void
  gate: Promise<void>
  open: () => void
  settle: () => void
}

const holds: Hold[] = []
const completed: string[] = []

const gatedPublish: PublishFn = async (path, contents, opts) => {
  const hold = holds.find(h => !h.claimed && h.match(path))
  if (hold) {
    hold.claimed = true
    hold.enter(path)
    await hold.gate
  }
  try {
    await realPublish(path, contents, opts)
  } finally {
    completed.push(path)
    hold?.settle()
  }
}

/**
 * Arm a one-shot gate: the NEXT publication whose path matches is held until
 * `release()` is called. Publications that do not match, and later matching
 * ones, are untouched.
 */
export function holdNextPublish(match: (path: string) => boolean): PublishHold {
  let enter!: (path: string) => void
  let open!: () => void
  let settle!: () => void
  const entered = new Promise<string>(res => {
    enter = res
  })
  const gate = new Promise<void>(res => {
    open = res
  })
  const settled = new Promise<void>(res => {
    settle = res
  })
  const hold: Hold = { match, claimed: false, enter, gate, open, settle }
  holds.push(hold)
  return {
    entered,
    settled,
    release: () => hold.open(),
  }
}

/** Publication completion order, oldest first (the on-disk landing order). */
export function completionOrder(): string[] {
  return [...completed]
}

/** Drop every armed gate (between sections of one proof). */
export function clearHolds(): void {
  for (const h of holds) h.open()
  holds.length = 0
}

/**
 * Drain `n` macrotask turns. This is a CONTROLLED SCHEDULING advance, not a
 * wall-clock sleep: it yields the loop a bounded number of times so already-
 * resolved continuations run, and it completes as fast as the machine can
 * drain them.
 */
export async function microturns(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>(res => setImmediate(res))
}

mock.module('../../src/substrate/durablePublish.ts', () => ({
  ...realExports,
  durableAtomicPublish: gatedPublish,
}))
