// ============================================================================
//  scripts/pings/prove-ping-engine.ts — the pings tap policy, driven
//  headless over the REAL translation chain: obligation rows →
//  obligationFacts (the bridge's own pure translation, fed the FULL open
//  set each time — its settled-tracking demands it) → foldAttention (the
//  one fold) → pingSliceOf → the engine. Production and proof share every
//  seam; the bell is a recorder.
//
//  Pinned lines:
//    §1 seed-silent BY OWNER TIME — a fact stamped before the engine's arm
//       never beeps, however late its gatherer's first load lands (a boot
//       never beeps for old news — deterministic, never a settle-window
//       race);
//    §2 a NEW obligation (stamped after the arm) rings once;
//    §3 THE POISON PIN — the same obligation raised twice (a revision bump)
//       rings once; the control proves the pin can catch the naive
//       per-revision re-ring;
//    §4 coalescing — taps within one second ring once; a later event rings
//       again;
//    §5 quiet by choice — bell off claims silently; toggling on never
//       back-rings; the next NEW event rings;
//    §6 finished runs ring per owner event; settled-class completions never
//       ring;
//    §7 an answered row leaving the set rings nothing;
//    §8 the bridge reads the ONE switchboard file the minting sides write.
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch home BEFORE imports — no prover touches the real config home.
const scratch = mkdtempSync(join(tmpdir(), 'pings-prove-'))
process.env.HOME = scratch
process.env.MERCURY_CONFIG_DIR = join(scratch, '.mercury')

const { foldAttention, emptyAttentionState } = await import(
  '../../src/services/attention/contracts.js'
)
const { obligationFacts, _resetObligationsBridgeForTesting } = await import(
  '../../src/services/crew/obligationsBridge.js'
)
const { createPingEngine, pingSliceOf } = await import(
  '../../src/services/pings/pingEngine.js'
)
type ObligationV1 = import('../../src/services/crew/obligations.js').ObligationV1

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

/** One obligation row: `born` is the owner's own mint stamp — the
 *  seed-silent basis under proof. */
function row(id: string, revision: number, born: number, question = 'a question'): ObligationV1 {
  return {
    schema: 1,
    obligationId: id,
    ref: `receipt:${id}`,
    sessionId: 'sess-1',
    question,
    principals: [],
    owner: 'operator',
    status: 'open',
    createdOrdinal: 1,
    revision,
    createdAtMs: born,
    updatedAtMs: born + revision,
    settlementAttempts: [],
    notifications: {},
  }
}

/** One rig: an engine armed at clock 10_000 over a ring recorder; the live
 *  open set folds through the REAL bridge translation each step. */
const ARM_AT = 10_000
function rig(opts?: { bellOn?: () => boolean }) {
  _resetObligationsBridgeForTesting()
  let rings = 0
  let clock = ARM_AT
  let state = emptyAttentionState()
  const engine = createPingEngine({
    ringBell: () => {
      rings += 1
    },
    bellEnabled: opts?.bellOn ?? (() => true),
    nowMs: () => clock,
    coalesceMs: 1000,
  })
  return {
    rings: () => rings,
    /** Fold the FULL open set at `ms`, then observe. */
    step: (ms: number, open: ObligationV1[]) => {
      clock = ms
      state = foldAttention(state, obligationFacts(open, 'operator', ms))
      engine.observe(pingSliceOf(state))
    },
    /** Fold raw attention facts at `ms` (the finished-run leg), then observe. */
    stepFacts: (ms: number, facts: Parameters<typeof foldAttention>[1]) => {
      clock = ms
      state = foldAttention(state, facts)
      engine.observe(pingSliceOf(state))
    },
    slice: () => pingSliceOf(state),
  }
}

//
section('§1 seed-silent by owner time — standing rows never beep, however late they load')
//
{
  const r = rig()
  // Both rows were minted BEFORE the arm (born 1000); their first load
  // lands LONG after the arm — 40 s in, far past any settle-window guess.
  const a = row('obl-a', 1, 1000)
  const b = row('obl-b', 1, 1000)
  r.step(ARM_AT + 40_000, [a, b])
  check('standing rows loading 40 s after arm ring nothing', r.rings() === 0, `rings=${r.rings()}`)
  r.step(ARM_AT + 41_000, [a, b])
  check('the same rows re-observed stay silent (claimed at seed)', r.rings() === 0, `rings=${r.rings()}`)

  //
  section('§2 a NEW obligation (stamped after the arm) rings once')
  //
  const c1 = row('obl-c', 1, ARM_AT + 42_000)
  r.step(ARM_AT + 42_000, [a, b, c1])
  check('the new row rings', r.rings() === 1, `rings=${r.rings()}`)

  //
  section('§3 THE POISON PIN — a re-raise (revision bump) rings once')
  //
  const c2 = row('obl-c', 2, ARM_AT + 42_000, 'the question, reworded')
  {
    // Control: the re-raise carries a DIFFERENT owner event id AND a newer
    // stamp, so a naive engine keyed per-revision WOULD re-ring — the pin
    // is non-vacuous.
    const before = obligationFacts([a, b, c1], 'operator', ARM_AT + 42_000).find(f => f.subjectId === 'obligation:obl-c')!
    const after = obligationFacts([a, b, c2], 'operator', ARM_AT + 43_000).find(f => f.subjectId === 'obligation:obl-c')!
    check(
      'control: the re-raise is a different, newer owner event (a per-revision engine would re-ring)',
      before.sourceEventId !== after.sourceEventId && after.atMs > ARM_AT,
      `${before.sourceEventId} vs ${after.sourceEventId}`,
    )
  }
  r.step(ARM_AT + 44_000, [a, b, c2])
  check('the re-raised obligation stays silent (one ring total)', r.rings() === 1, `rings=${r.rings()}`)

  //
  section('§4 coalescing — taps within one second ring once')
  //
  const d = row('obl-d', 1, ARM_AT + 45_000)
  const e = row('obl-e', 1, ARM_AT + 45_000)
  r.step(ARM_AT + 45_000, [a, b, c2, d, e])
  check('two new rows in one observe ring once (one beep for the pair)', r.rings() === 2, `rings=${r.rings()}`)
  const f = row('obl-f', 1, ARM_AT + 45_200)
  r.step(ARM_AT + 45_200, [a, b, c2, d, e, f])
  check('a third row 200ms later folds into the open window', r.rings() === 2, `rings=${r.rings()}`)
  const g = row('obl-g', 1, ARM_AT + 46_500)
  r.step(ARM_AT + 46_500, [a, b, c2, d, e, f, g])
  check('a row after the window rings again', r.rings() === 3, `rings=${r.rings()}`)

  //
  section('§7 an answered row leaving the set rings nothing')
  //
  r.step(ARM_AT + 48_000, [a, b, c2, d, e, f])
  check('the settled row leaves silently', r.rings() === 3, `rings=${r.rings()}`)
  check(
    'the needs-you slice no longer carries the settled row',
    r.slice().needsYou.every(i => i.subjectId !== 'obligation:obl-g'),
  )
}

//
section('§5 quiet by choice — bell off claims, never back-rings')
//
{
  let bellOn = false
  const r = rig({ bellOn: () => bellOn })
  r.step(ARM_AT + 10, [])
  const q = row('obl-q', 1, ARM_AT + 500)
  r.step(ARM_AT + 500, [q])
  check('bell off: the new row claims without a beep', r.rings() === 0, `rings=${r.rings()}`)
  bellOn = true
  r.step(ARM_AT + 600, [q])
  check('toggling on never back-rings the claimed row', r.rings() === 0, `rings=${r.rings()}`)
  const s = row('obl-r', 1, ARM_AT + 700)
  r.step(ARM_AT + 700, [q, s])
  check('the next NEW row rings', r.rings() === 1, `rings=${r.rings()}`)
}

//
section('§6 finished runs — per owner event; settled-class never rings')
//
{
  const r = rig()
  const runFact = (id: string, eventId: string, reason: 'run-completed' | 'settled', atMs: number) => ({
    subjectId: id,
    owner: 'run-manifest' as const,
    sourceEventId: eventId,
    bucket: 'completed' as const,
    reasonCode: reason,
    reasonLabel: 'a run settled',
    sinceMs: 100,
    atMs,
    urgency: 2 as const,
  })
  r.step(ARM_AT + 10, [])
  // A completion stamped BEFORE the arm seeds silently (old news), one
  // stamped after rings.
  r.stepFacts(ARM_AT + 400, [runFact('thread:t0', 'wb:t0:state:completed', 'run-completed', 900)])
  check('a completion stamped before the arm seeds silently', r.rings() === 0, `rings=${r.rings()}`)
  r.stepFacts(ARM_AT + 500, [runFact('thread:t1', 'wb:t1:state:completed', 'run-completed', ARM_AT + 500)])
  check('a finished run rings', r.rings() === 1, `rings=${r.rings()}`)
  r.stepFacts(ARM_AT + 2000, [])
  check('the same completion replayed is silent', r.rings() === 1, `rings=${r.rings()}`)
  r.stepFacts(ARM_AT + 3000, [runFact('thread:t1', 'wb:t1:state:completed:rerun-2', 'run-completed', ARM_AT + 3000)])
  check('a NEW completion event of the same lane rings again', r.rings() === 2, `rings=${r.rings()}`)
  r.stepFacts(ARM_AT + 4500, [runFact('thread:t2', 'wb:t2:state:stopped', 'settled', ARM_AT + 4500)])
  check("a settled-class completion (reason 'settled') never rings", r.rings() === 2, `rings=${r.rings()}`)
  check(
    'pingSliceOf keeps only run-completed in the finished-runs slice',
    r.slice().finishedRuns.every(i => i.subjectId === 'thread:t0' || i.subjectId === 'thread:t1'),
    JSON.stringify(r.slice().finishedRuns.map(i => i.subjectId)),
  )
}

//
section('§8 the bridge reads the ONE file the minting sides write (switchboard scope)')
//
{
  const { readFileSync } = await import('node:fs')
  const { join: j } = await import('node:path')
  const root = new URL('../..', import.meta.url).pathname
  const bridge = readFileSync(j(root, 'src', 'services', 'crew', 'obligationsBridge.ts'), 'utf8')
  check(
    "the cache refresh reads scope 'switchboard' (the daemon's asks reach the badge, the boards and the engine)",
    /openObligations\(\{ scope: 'switchboard' \}\)/.test(bridge),
  )
  check(
    'the change seam subscribes on the same scope',
    /subscribeObligations\([\s\S]{0,80}?\{ scope: 'switchboard' \}\)/.test(bridge),
  )
  const dispatch = readFileSync(j(root, 'src', 'services', 'crew', 'dispatch.ts'), 'utf8')
  check(
    'the dispatch raiser mints into the switchboard scope (never a cwd-hashed side file)',
    (dispatch.match(/scope: 'switchboard'/g) ?? []).length >= 2,
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL PING-ENGINE PROOFS PASS')
else console.log(`${failures} PING-ENGINE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
