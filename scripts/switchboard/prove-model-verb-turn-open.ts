#!/usr/bin/env bun
// ============================================================================
//  prove-model-verb-turn-open — a model switch asked for while a turn is
//  open parks, whatever the turn cap says (release-hardening audit rank 69).
//
//  The gap: the daemon's seat verbs read the roster row's `busy` bit, which
//  is the back-pressure DECISION — turnActive AND inside the twenty-minute
//  turn cap (MERCURY_IMPLEMENTER_MAX_TURN_MS). The cap's release exists to
//  keep dispatch from starving on a wedged seat; it is not a statement that
//  the turn ended. A /model past the cap applied immediately: the seat's
//  model facts flipped while the in-flight turn kept running the old model,
//  the operator's receipt said applied instead of queued, and in the
//  session process the three /model rows were pushed into the live
//  conversation mid-turn, so the persisted order read as though the model
//  was switched before the prompt that was already running.
//
//    T1 the seat's turn-open predicate: the raw turn fact wins over the
//       capped decision; the decision is the fallback with no turn fact;
//       a settled seat is never busy
//    T2 the roster row carries the raw fact beside the decision (source pin)
//    T3 the runner defers its /model breadcrumbs while a turn is in flight
//       and flushes them at the turn boundary (source pins)
//
//  PROVE_SRC names another checkout's src (the A/B control: T1-T3 read red
//  at the pre-fix tree).
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = join(process.env.TMPDIR ?? '/tmp', `model-verb-turn-open-${process.pid}`)
const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const seat = await import(join(SRC, 'daemon/sessionSeat.ts'))
const open = seat.seatTurnOpen as ((row: { outcome?: string; busy?: boolean; turnActive?: boolean } | undefined) => boolean) | undefined

console.log('T1 the turn-open predicate')
check('the predicate is exported', typeof open === 'function')
check('a turn past the cap (busy false, turnActive true) is OPEN — the switch parks', open?.({ busy: false, turnActive: true }) === true)
check('a turn inside the cap is open', open?.({ busy: true, turnActive: true }) === true)
check('a seat whose turn ended is not', open?.({ busy: false, turnActive: false }) === false)
check('with no turn fact the capped decision is the fallback (busy)', open?.({ busy: true }) === true)
check('with no turn fact the capped decision is the fallback (idle)', open?.({ busy: false }) === false)
check('a settled seat is never busy, whatever the bits', open?.({ outcome: 'degraded', busy: true, turnActive: true }) === false)
check('an unknown seat is not busy', open?.(undefined) === false)

console.log('T2 the roster row carries the raw fact (source pin)')
{
  const roster = readFileSync(join(SRC, 'daemon/roster.ts'), 'utf8')
  check('list() projects turnActive beside busy', roster.includes('e.turnActive = h.longLived.turnActive'))
  const protocol = readFileSync(join(SRC, 'daemon/protocol.ts'), 'utf8')
  check('the wire entry declares it', /turnActive\?: boolean/.test(protocol))
  const seatSrc = readFileSync(join(SRC, 'daemon/sessionSeat.ts'), 'utf8')
  check('every seat verb reads the one predicate', seatSrc.includes('return seatTurnOpen(roster.list().find(j => j.short === short))'))
}

console.log('T3 the runner defers the breadcrumbs to the turn boundary (source pins)')
{
  const runner = readFileSync(join(SRC, 'cli/print.ts'), 'utf8')
  check('set_model defers while a turn is in flight', runner.includes('if (inFlightAbort !== null) deferredModelBreadcrumb = String(resolved)'))
  check('the settings road defers the same way', runner.includes('if (inFlightAbort !== null) deferredModelBreadcrumb = resolvedNow'))
  const boundary = runner.slice(runner.indexOf('inFlightAbort = null\n      if (deferredModelBreadcrumb !== null)'), runner.indexOf('inFlightAbort = null\n      if (deferredModelBreadcrumb !== null)') + 300)
  check('the turn boundary flushes the deferred rows', boundary.includes('await injectModelSwitchBreadcrumbs(toModel)'))
}

console.log(failures === 0 ? '\nprove-model-verb-turn-open: ALL PASS' : `\nprove-model-verb-turn-open: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
