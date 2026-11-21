#!/usr/bin/env bun

let failures = 0
const gateRouteFile = 'src/context/surfaceRoute.ts'
const check = (label: string, cond: boolean, detail = '', fix = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fix ? ` — ${fix}` : ''}`)
}


console.log('\n§2 the mechanism (real store · real emitter · real landing gate)')
process.env.MERCURY_CONFIG_DIR = '/tmp/swift-entry-gate-home'
const { EventEmitter } = await import('../../src/ink/events/emitter.ts')
const inputEvent = await import('../../src/ink/events/input-event.ts')
const { InputEvent, inputConsumedThroughSeq } = inputEvent
const sr = await import('../../src/context/surfaceRoute.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')

const enterKey = (): InstanceType<typeof InputEvent> =>
  new InputEvent({ name: 'return', sequence: '\r', ctrl: false, meta: false, shift: false, option: false, super: false, fn: false, isPasted: false } as never)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

interface Walk {
  emitter: InstanceType<typeof EventEmitter>
  composerSaw: number[]
  landingSettled: () => boolean
  landingResolve: (ok: boolean) => void
}

function armWorld(): Walk {
  sr._resetSurfaceRouteForTesting()
  slot._resetFocusedSessionConnectorForTesting()
  sr.registerRouteSurface('concourse', { render: () => null })
  sr.registerRouteSurface('boot-settings', { render: () => null })
  sr.registerChatPresence({
    present: () => slot.hasFocusedSession() || slot.landingInFlight(),
    subscribe: slot.subscribeFocusedSessionConnector,
  })
  sr.enterConcourse()
  const emitter = new EventEmitter()
  const composerSaw: number[] = []
  emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind !== 'repl') return
    if (sr.isPriorGenerationInput(e.seq)) return
    if (e.key.return) composerSaw.push(e.seq)
  })
  let armed = false
  let settled = false
  let resolveLanding: (ok: boolean) => void = () => {}
  emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind !== 'concourse' || !e.key.return) return
    e.stopImmediatePropagation()
    if (!armed) {
      armed = true
      return
    }
    const landing = slot.withLanding(
      new Promise<{ ok: boolean }>(r => {
        resolveLanding = (ok: boolean) => r({ ok })
      }),
    )
    const flipped = sr.enterRootChat().ok ? sr.surfaceGeneration() : null
    void (async () => {
      const hop = await landing
      settled = true
      if (!hop.ok) {
        if (flipped !== null && sr.surfaceGeneration() === flipped) sr.returnToConcourse()
        return
      }
      slot.setFocusedSessionConnector({ sessionId: () => 's1' } as never)
    })()
  })
  return { emitter, composerSaw, landingSettled: () => settled, landingResolve: (ok: boolean) => resolveLanding(ok) }
}

function dispatchChunk(w: Walk, events: InstanceType<typeof InputEvent>[], keyboardSaw?: number[]): void {
  let chunkConsumed = false
  for (const event of events) {
    if (chunkConsumed) continue
    w.emitter.emit('input', event)
    if (event.seq <= inputConsumedThroughSeq()) {
      chunkConsumed = true
      continue
    }
    keyboardSaw?.push(event.seq)
    if (event.seq <= inputConsumedThroughSeq()) chunkConsumed = true
  }
}

{
  const w = armWorld()
  const keyboardSaw: number[] = []
  const e1 = enterKey()
  const e2 = enterKey()
  const e3 = enterKey()
  dispatchChunk(w, [e1], keyboardSaw)
  dispatchChunk(w, [e2, e3], keyboardSaw)
  check('the confirming ↵ committed in its own dispatch (route = repl at chunk end)', sr.currentSurfaceRoute().kind === 'repl', '', `check enterRootChat and commitTransition in ${gateRouteFile}`)
  check('the chat was in flight at the flip (the landing armed synchronously)', sr.chatPresent(), '', `chatPresent in ${gateRouteFile} must count slot.landingInFlight() from src/services/engine-connector/focusedConnector.ts as present`)
  check('the committing ↵ and its chunk-mate reached the composer NEVER', w.composerSaw.length === 0, `saw: ${w.composerSaw.join(',')}`, `commitTransition in ${gateRouteFile} must call markInputConsumedThroughCurrentSeq so the rest of the chunk is dropped`)
  check('the chunk-mate reached the keyboard lane NEVER (the guard)', !keyboardSaw.includes(e3.seq), `keyboard saw: ${keyboardSaw.join(',')}`, `inputConsumedThroughSeq in src/ink/events/input-event.ts must advance at the commit (set by commitTransition in ${gateRouteFile})`)
  check('the committing ↵ is prior-generation to the revealed surface', sr.isPriorGenerationInput(e2.seq) && sr.isPriorGenerationInput(e3.seq), '', `isPriorGenerationInput must compare against lastTransition.commitSeq, recorded in commitTransition in ${gateRouteFile}`)
  w.landingResolve(true)
  await sleep(0)
  check('the hop landed BEHIND the flip (slot pointed after the commit)', w.landingSettled() && slot.hasFocusedSession(), '', 'the landing handler in armWorld of this file must set the focused connector after the flip; also see src/services/engine-connector/focusedConnector.ts')
  const e4 = enterKey()
  dispatchChunk(w, [e4])
  check('a fresh post-reveal ↵ lands in the composer (zero functionality)', w.composerSaw.includes(e4.seq), `saw: ${w.composerSaw.join(',')}`, `an input decoded after the commit must not be dropped; check isPriorGenerationInput and commitTransition in ${gateRouteFile}`)
}

{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  const e2 = enterKey()
  dispatchChunk(w, [e2])
  const e3 = enterKey()
  dispatchChunk(w, [e3])
  check('the impatient third ↵ is NEW-generation (decoded after the commit)', !sr.isPriorGenerationInput(e3.seq), '', `lastTransition.commitSeq in ${gateRouteFile} must be the sequence at the commit, not later`)
  check(
    'it lands in the revealed composer as the operator\'s own keypress — never as a replay of the entry',
    w.composerSaw.length === 1 && w.composerSaw[0] === e3.seq,
    `saw: ${w.composerSaw.join(',')}`,
    `a keypress decoded after the commit must reach the composer once; check isPriorGenerationInput and markInputConsumedThroughCurrentSeq use in ${gateRouteFile}`,
  )
  w.landingResolve(true)
  await sleep(0)
}

{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  dispatchChunk(w, [enterKey()])
  check('flipped onto the landing', sr.currentSurfaceRoute().kind === 'repl', '', `enterRootChat in ${gateRouteFile} must flip to the chat route while a landing is in flight`)
  w.landingResolve(false)
  await sleep(0)
  check('the failed landing returned the frame to the board', sr.currentSurfaceRoute().kind === 'concourse', '', `returnToConcourse in ${gateRouteFile} must be reachable after the failed landing; see the landing handler in armWorld of this file`)
}

{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  dispatchChunk(w, [enterKey()])
  sr.enterBootSettings()
  w.landingResolve(false)
  await sleep(0)
  check('the operator\'s later ground stands (no yank back to the board)', sr.currentSurfaceRoute().kind === 'boot-settings', '', `the return to the board must be skipped when surfaceGeneration in ${gateRouteFile} moved on; see the landing handler in armWorld of this file`)
}

console.log('\n§3 the edges (pointer entry · the ↵ neighbors · the settled leg)')

{
  sr._resetSurfaceRouteForTesting()
  slot._resetFocusedSessionConnectorForTesting()
  sr.registerRouteSurface('concourse', { render: () => null })
  sr.enterConcourse()
  const emitter = new EventEmitter()
  const boardSaw: number[] = []
  emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    boardSaw.push(e.seq)
  })
  const queued = enterKey()
  inputEvent.bumpInputEventSeqForMouse()
  const genBefore = sr.surfaceGeneration()
  sr.consumeEntryDecisionInput()
  check('the pointer decision changes NO route (stay-in-split)', sr.currentSurfaceRoute().kind === 'concourse' && sr.surfaceGeneration() === genBefore, '', `consumeEntryDecisionInput in ${gateRouteFile} must only mark input consumed, never change the route`)
  emitter.emit('input', queued)
  check('a keystroke decoded before the click dies at the emitter (the chunk law reaches the pointer lane)', !boardSaw.includes(queued.seq), '', `consumeEntryDecisionInput in ${gateRouteFile} must call markInputConsumedThroughCurrentSeq`)
  check(
    'the no-transition consumption re-classes nothing (the standing route\'s own handlers stay live by decode order)',
    !sr.isPriorGenerationInput(queued.seq + 1),
    '',
    `consumeEntryDecisionInput in ${gateRouteFile} must not touch lastTransition.commitSeq`,
  )
  const after = enterKey()
  emitter.emit('input', after)
  check('the next keystroke lands on the standing surface (zero functionality)', boardSaw.includes(after.seq), '', `consumeEntryDecisionInput in ${gateRouteFile} must consume only up to the current sequence`)
}

{
  const w = armWorld()
  const neighborSaw: number[] = []
  w.emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind !== 'concourse' || !e.key.return) return
    neighborSaw.push(e.seq)
  })
  dispatchChunk(w, [enterKey()])
  const e2 = enterKey()
  const mate = enterKey()
  dispatchChunk(w, [e2, mate])
  check('the entry decision starves the neighbor of the chunk-mate (no phantom broadcast)', neighborSaw.length === 0, `neighbor saw: ${neighborSaw.join(',')}`, `commitTransition in ${gateRouteFile} must mark the chunk consumed; dispatchChunk in this file stops the chunk once inputConsumedThroughSeq passes it`)
  w.landingResolve(true)
  await sleep(0)
}
{
  sr._resetSurfaceRouteForTesting()
  sr.registerRouteSurface('concourse', { render: () => null })
  sr.enterConcourse()
  const emitter = new EventEmitter()
  const neighborSaw: number[] = []
  emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind === 'concourse' && e.key.return) neighborSaw.push(e.seq)
  })
  const own = enterKey()
  emitter.emit('input', own)
  check('an entry-less ↵ reaches the neighbor untouched (nothing over-eats)', neighborSaw.includes(own.seq), '', `an input with no entry decision must not be consumed; see markInputConsumedThroughCurrentSeq callers in ${gateRouteFile}`)
}

{
  sr._resetSurfaceRouteForTesting()
  slot._resetFocusedSessionConnectorForTesting()
  sr.registerRouteSurface('concourse', { render: () => null })
  sr.registerRouteSurface('boot-settings', { render: () => null })
  sr.registerChatPresence({
    present: () => slot.hasFocusedSession() || slot.landingInFlight(),
    subscribe: slot.subscribeFocusedSessionConnector,
  })
  sr.enterConcourse()
  const emitter = new EventEmitter()
  const boardSaw: number[] = []
  emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind === 'concourse') boardSaw.push(e.seq)
  })
  const op = { gen: sr.surfaceGeneration() }
  const during = enterKey()
  emitter.emit('input', during)
  check('input during the settled wait lands on the board (functionality preserved)', boardSaw.includes(during.seq), '', `no route commit happens in the settled wait; see commitTransition in ${gateRouteFile}`)
  slot.setFocusedSessionConnector({ sessionId: () => 's-settled' } as never)
  const undispatched = enterKey()
  if (sr.surfaceGeneration() === op.gen) sr.enterRootChat()
  check('the settled flip landed (the operator had not navigated)', sr.currentSurfaceRoute().kind === 'repl', '', `enterRootChat in ${gateRouteFile} must flip when a focused session exists`)
  emitter.emit('input', undispatched)
  check('the queued remainder dies at the flip (aimed at a world that left)', !boardSaw.includes(undispatched.seq) && sr.isPriorGenerationInput(undispatched.seq), '', `commitTransition in ${gateRouteFile} must mark input consumed and record commitSeq`)
  const fresh = enterKey()
  check('the next decoded keystroke is the revealed world\'s own', !sr.isPriorGenerationInput(fresh.seq), '', `lastTransition.commitSeq in ${gateRouteFile} must not exceed the sequence at the commit`)
  sr.returnToConcourse()
  const op2 = { gen: sr.surfaceGeneration() }
  sr.enterBootSettings()
  if (sr.surfaceGeneration() === op2.gen) sr.enterRootChat()
  check('the settled leg never yanks a navigated operator', sr.currentSurfaceRoute().kind === 'boot-settings', '', `the settled leg must flip only when surfaceGeneration in ${gateRouteFile} is unchanged; see the settled leg in this file`)
}

console.log(failures === 0 ? '\nprove-swift-entry-gate: ALL LAWS HOLD' : `\nprove-swift-entry-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
