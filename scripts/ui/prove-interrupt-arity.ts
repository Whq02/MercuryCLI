#!/usr/bin/env bun

let failures = 0
function check(label: string, cond: boolean, detail = '', fix = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}

const I = 'src/screen/composer/input-core/interruptArity.ts'
const arity = await import('../../src/screen/composer/input-core/interruptArity.ts')

console.log('§1 — the default: ONE esc interrupts, stateless')
{
  check('an undeclared scope resolves arity 1', arity.interruptArityOf('chat').arity === 1, '', `interruptArityOf must default to arity 1 for a scope with no declaration (${I})`)
  const p1 = arity.pressInterrupt('chat', 1000)
  const p2 = arity.pressInterrupt('chat', 1001)
  check('every press fires (no arming, no window)', p1.fire && p2.fire, '', `${JSON.stringify([p1, p2])} — pressInterrupt must fire on every press while a scope is undeclared (${I})`)
}

console.log('§2 — a declared arity-2 scope: arm · hint · fire inside the window')
{
  const undeclare = arity.declareInterruptArity('room', { arity: 2, hint: 'esc esc interrupts', windowMs: 3000 })
  const arm = arity.pressInterrupt('room', 10_000)
  check('the first press ARMS and hands back the hint', !arm.fire && !arm.fire && (arm as { hint?: string }).hint === 'esc esc interrupts', JSON.stringify(arm), `the first pressInterrupt on an arity-2 scope must return fire false with the declared hint (${I})`)
  const fire = arity.pressInterrupt('room', 11_500)
  check('the second press inside the window FIRES', fire.fire, '', `${JSON.stringify(fire)} — pressInterrupt must fire on the second press within windowMs (${I})`)
  const rearm = arity.pressInterrupt('room', 11_600)
  check('after a fire the latch is fresh (the next press arms again)', !rearm.fire, '', `${JSON.stringify(rearm)} — pressInterrupt must clear its latch after a fire (${I})`)
  const late = arity.pressInterrupt('room', 20_000)
  check('a press PAST the window re-arms instead of firing', !late.fire, '', `${JSON.stringify(late)} — pressInterrupt must arm again when the previous press is older than windowMs (${I})`)
  const inWindow = arity.pressInterrupt('room', 21_000)
  check('…and the follow-up inside the fresh window fires', inWindow.fire, '', `${JSON.stringify(inWindow)} — the re-arming press must start a new window that a second press fires in (${I})`)
  arity.disarmInterruptGesture('room')
  const afterDisarm = arity.pressInterrupt('room', 21_100)
  check('a disarm (focus left mid-gesture) drops the half-press', !afterDisarm.fire, '', `${JSON.stringify(afterDisarm)} — disarmInterruptGesture must clear an armed press (${I})`)
  undeclare()
  check('undeclared again: back to one-esc', arity.pressInterrupt('room', 22_000).fire, '', `the function declareInterruptArity returns must remove the declaration so pressInterrupt fires at once (${I})`)
}

console.log('§3 — declaration hygiene')
{
  const first = arity.declareInterruptArity('s', { arity: 2 })
  const resolved = arity.interruptArityOf('s')
  check('defaults fill the declaration (hint + the ruled 3 s window)', resolved.windowMs === 3000 && resolved.hint.length > 0, JSON.stringify(resolved), `interruptArityOf must fill the default hint and the 3000 ms window (${I})`)
  arity.declareInterruptArity('s', { arity: 2, hint: 'newer', windowMs: 5000 })
  first()
  check('a STALE undeclare from a replaced declaration is a no-op', arity.interruptArityOf('s').hint === 'newer' && arity.interruptArityOf('s').windowMs === 5000, '', `${JSON.stringify(arity.interruptArityOf('s'))} — the undeclare returned by an older declareInterruptArity must not remove a newer declaration (${I})`)
}


console.log(failures === 0 ? '\nprove-interrupt-arity: ALL LAWS HOLD' : `\nprove-interrupt-arity: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
