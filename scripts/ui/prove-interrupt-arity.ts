#!/usr/bin/env bun
// ============================================================================
//  prove-interrupt-arity — THE SURFACE-SCOPED INTERRUPT ARM (operator
//  ruling): the main chat interrupts on ONE esc (the default
//  arity — the esc-interrupts drive pins the live behavior end-to-end);
//  a surface may declare arity 2 (esc-esc inside a window, hint on the
//  first press) without forking the ladder owner. This prover pins the
//  declaration seam pure, plus the ladder-owner wiring at source level.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const arity = await import('../../src/input-core/interruptArity.ts')

console.log('§1 — the default: ONE esc interrupts, stateless')
{
  check('an undeclared scope resolves arity 1', arity.interruptArityOf('chat').arity === 1)
  const p1 = arity.pressInterrupt('chat', 1000)
  const p2 = arity.pressInterrupt('chat', 1001)
  check('every press fires (no arming, no window)', p1.fire && p2.fire)
}

console.log('§2 — a declared arity-2 scope: arm · hint · fire inside the window')
{
  const undeclare = arity.declareInterruptArity('minerva-room', { arity: 2, hint: 'esc esc interrupts minerva', windowMs: 3000 })
  const arm = arity.pressInterrupt('minerva-room', 10_000)
  check('the first press ARMS and hands back the hint', !arm.fire && !arm.fire && (arm as { hint?: string }).hint === 'esc esc interrupts minerva', JSON.stringify(arm))
  const fire = arity.pressInterrupt('minerva-room', 11_500)
  check('the second press inside the window FIRES', fire.fire)
  const rearm = arity.pressInterrupt('minerva-room', 11_600)
  check('after a fire the latch is fresh (the next press arms again)', !rearm.fire)
  const late = arity.pressInterrupt('minerva-room', 20_000)
  check('a press PAST the window re-arms instead of firing', !late.fire)
  const inWindow = arity.pressInterrupt('minerva-room', 21_000)
  check('…and the follow-up inside the fresh window fires', inWindow.fire)
  arity.disarmInterruptGesture('minerva-room')
  const afterDisarm = arity.pressInterrupt('minerva-room', 21_100)
  check('a disarm (focus left mid-gesture) drops the half-press', !afterDisarm.fire)
  undeclare()
  check('undeclared again: back to one-esc', arity.pressInterrupt('minerva-room', 22_000).fire)
}

console.log('§3 — declaration hygiene')
{
  const first = arity.declareInterruptArity('s', { arity: 2 })
  const resolved = arity.interruptArityOf('s')
  check('defaults fill the declaration (hint + the ruled 3 s window)', resolved.windowMs === 3000 && resolved.hint.length > 0, JSON.stringify(resolved))
  arity.declareInterruptArity('s', { arity: 2, hint: 'newer', windowMs: 5000 })
  first()
  check('a STALE undeclare from a replaced declaration is a no-op', arity.interruptArityOf('s').hint === 'newer' && arity.interruptArityOf('s').windowMs === 5000)
}

console.log('§4 — the ladder owner consumes the seam (source pin)')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/hooks/useCancelRequest.ts'), 'utf8')
  check("the chat's running-turn esc routes through pressInterrupt('chat')", src.includes("pressInterrupt('chat')"))
  check('an unfired press paints the hint, never a silent eat', /press\.hint/.test(src))
  const afterCtrlC = src.slice(src.indexOf("'app:interrupt'"))
  check('ctrl+c (app:interrupt) stays immediate — the exit grammar untouched', afterCtrlC.length > 0 && !afterCtrlC.includes('pressInterrupt('))
}

console.log(failures === 0 ? '\nprove-interrupt-arity: ALL LAWS HOLD' : `\nprove-interrupt-arity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
