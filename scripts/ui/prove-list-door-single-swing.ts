#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-list-door-single-swing.ts — THE DOOR-IN-SWING GUARD
//  (SWIFTVERIFY W1): an async list door (a hop, a birth behind an
//  AsyncListNote) swings ONCE per human gesture. The boot-face doors run
//  pending-note → await hop/birth → route commit in the continuation, and
//  route-commit consumption cannot reach a face's ↵↵ (only route commits
//  stamp the input watermark) — so before this guard, a doubled ↵ on New
//  Session admitted TWO sessions (and the second wore a different kit: the
//  worn preset is at-most-once).
//
//  Two layers, the entry-gate pattern:
//   §1 SOURCE: useInteractiveList's runPrimary declines while an
//      AsyncListNote's promise is unresolved; BOTH resolution arms release
//      the guard (the ruled row-re-pressable retry stays); the note's
//      supersede path never releases it.
//   §2 MECHANISM, driven with the pair shaped exactly as §1 pins the
//      source: ↵↵ in one dispatch swings the door once; the resolution
//      releases (a third ↵ retries — zero functionality lost); a REJECTED
//      door releases the same way; a selection move mid-swing supersedes
//      the note but never the guard.
//
//  cpu-pure: no PTY, no daemon, no Mercury boot.
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── §1 the source ───────────────────────────────────────────────────────────
console.log('§1 the guard at the owner (useInteractiveList)')
const list = readFileSync('src/components/mercury-ui/useInteractiveList.ts', 'utf8')
const runPrimaryAt = list.indexOf('const runPrimary = ')
const runPrimaryBody = list.slice(runPrimaryAt, list.indexOf('const activate = ', runPrimaryAt))
check(
  'runPrimary declines FIRST while a door is in swing',
  runPrimaryBody.indexOf('if (pendingActionSeqRef.current !== null) return') > 0 &&
    runPrimaryBody.indexOf('if (pendingActionSeqRef.current !== null) return') <
      runPrimaryBody.indexOf('actions.find'),
)
check(
  'the AsyncListNote receipt arms the guard',
  /pendingActionSeqRef\.current = seq\s*\n\s*setNote\(res\.pending\)/.test(list),
)
check(
  'BOTH resolution arms release it (retry stays)',
  (list.match(/if \(pendingActionSeqRef\.current === seq\) pendingActionSeqRef\.current = null/g) ?? []).length === 2,
)
check(
  'the selection move supersedes the NOTE only, never the guard',
  /noteSeqRef\.current\+\+\s*\n\s*setNote\(null\)/.test(list) && !/select[\s\S]{0,200}pendingActionSeqRef\.current = null/.test(list),
)

// ── §2 the mechanism, driven ────────────────────────────────────────────────
//  The pair below is the product pair byte-shaped (§1 pins the source to
//  exactly this ordering); the door is a counting async gate standing in for
//  bornSession/the hop — the ONE swing per gesture is what is driven.
console.log('\n§2 the mechanism (↵↵ swings once · resolution releases · retry stays)')
type AsyncNote = { pending: string; result: Promise<string | null> }
function armWorld(): {
  press: () => void
  select: () => void
  door: () => void
  swings: () => number
  note: () => string | null
  resolveDoor: (outcome: 'ok' | 'reject') => Promise<void>
} {
  let swings = 0
  let note: string | null = null
  let noteSeq = 0
  let pendingActionSeq: number | null = null
  let settle: { resolve: (v: string | null) => void; reject: (e: unknown) => void } | null = null
  const applyActionResult = (res: string | null | AsyncNote): void => {
    const seq = ++noteSeq
    if (res != null && typeof res === 'object') {
      pendingActionSeq = seq
      note = res.pending
      void res.result.then(
        resolved => {
          if (pendingActionSeq === seq) pendingActionSeq = null
          if (noteSeq === seq) note = resolved ?? null
        },
        () => {
          if (pendingActionSeq === seq) pendingActionSeq = null
          if (noteSeq === seq) note = null
        },
      )
      return
    }
    note = res ?? null
  }
  const door = (): AsyncNote => ({
    pending: 'opening…',
    result: new Promise<string | null>((resolve, reject) => {
      swings += 1
      settle = { resolve, reject }
    }),
  })
  const runPrimary = (): void => {
    if (pendingActionSeq !== null) return
    applyActionResult(door())
  }
  return {
    press: runPrimary,
    select: () => {
      noteSeq++
      note = null
    },
    door: () => void 0,
    swings: () => swings,
    note: () => note,
    resolveDoor: async (outcome: 'ok' | 'reject'): Promise<void> => {
      if (outcome === 'ok') settle?.resolve(null)
      else settle?.reject(new Error('refused'))
      settle = null
      await new Promise(r => setTimeout(r, 0))
    },
  }
}

// — walk 1: the fast double-tap (↵↵ in one dispatch) —
{
  const w = armWorld()
  w.press()
  w.press()
  check('↵↵ swings the door ONCE (one birth, not two)', w.swings() === 1, `swings=${w.swings()}`)
  check('…with the pending note up', w.note() === 'opening…')
  await w.resolveDoor('ok')
  w.press()
  check('the resolution releases: a fresh ↵ swings again (zero functionality)', w.swings() === 2, `swings=${w.swings()}`)
  await w.resolveDoor('ok')
}

// — walk 2: the REFUSED door retries (the ruled row-re-pressable law) —
{
  const w = armWorld()
  w.press()
  await w.resolveDoor('reject')
  w.press()
  check('a rejected door releases the guard the same way (↵ retries)', w.swings() === 2, `swings=${w.swings()}`)
  await w.resolveDoor('ok')
}

// — walk 3: a selection move mid-swing supersedes the note, never the guard —
{
  const w = armWorld()
  w.press()
  w.select()
  check('the move clears the pending note', w.note() === null)
  w.press()
  check('…but the door stays in swing (no second birth through a moved cursor)', w.swings() === 1, `swings=${w.swings()}`)
  await w.resolveDoor('ok')
  w.press()
  check('…and the resolution still releases after the move', w.swings() === 2, `swings=${w.swings()}`)
  await w.resolveDoor('ok')
}

// ── §3 the one NON-list birth door carries the same guard ───────────────────
//  The board's newSession (ConcourseRoute) is reachable outside any list:
//  the n-card's answer, the split pane's direct ↵. One ref guards the door
//  for every caller; the finally releases either way so 'n retries' stays
//  true.
console.log('\n§3 the non-list birth door (the board\'s newSession)')
const concourseRoute = readFileSync('src/components/concourse/ConcourseRoute.tsx', 'utf8')
const newSessionAt = concourseRoute.indexOf('newSession: (opts?: { contractText?: string }) => {')
const newSessionBody = concourseRoute.slice(newSessionAt, concourseRoute.indexOf('submitSessionDraft:', newSessionAt))
check(
  'the door declines while a birth is in swing, before the pending note',
  newSessionBody.indexOf('if (birthInFlightRef.current) return') > 0 &&
    newSessionBody.indexOf('if (birthInFlightRef.current) return') < newSessionBody.indexOf('noteControl'),
)
check('…arming before the async body', newSessionBody.includes('birthInFlightRef.current = true') && newSessionBody.indexOf('birthInFlightRef.current = true') < newSessionBody.indexOf('void (async () => {'))
check('…and the finally releases either way (n retries stays true)', /finally \{\s*\n\s*birthInFlightRef\.current = false/.test(newSessionBody))

console.log(failures === 0 ? '\nprove-list-door-single-swing: ALL LAWS HOLD' : `\nprove-list-door-single-swing: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
