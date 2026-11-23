#!/usr/bin/env bun

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}


console.log('\n§2 the mechanism (real store · real emitter · real landing gate)')
process.env.MERCURY_CONFIG_DIR = '/tmp/swift-entry-gate-home'
const { EventEmitter } = await import('../../src/screen/renderer/events/emitter.ts')
const inputEvent = await import('../../src/screen/renderer/events/input-event.ts')
const { InputEvent, inputConsumedThroughSeq } = inputEvent
const sr = await import('../../src/screen/routes/surfaceRoute.ts')
const slot = await import('../../src/engine/connector/focusedConnector.ts')

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
  check('the confirming ↵ committed in its own dispatch (route = repl at chunk end)', sr.currentSurfaceRoute().kind === 'repl', '', 'enterRootChat in src/screen/routes/surfaceRoute.ts must switch the route to the repl root chat when chatPresent() is true (the chat presence registered by armWorld)')
  check('the chat was in flight at the flip (the landing armed synchronously)', sr.chatPresent(), '', 'chatPresent in src/screen/routes/surfaceRoute.ts must be true while landingInFlight() in src/engine/connector/focusedConnector.ts is true; withLanding must mark the landing in flight synchronously')
  check('the committing ↵ and its chunk-mate reached the composer NEVER', w.composerSaw.length === 0, `saw: ${w.composerSaw.join(',')}`, 'the route commit in src/screen/routes/surfaceRoute.ts (commitTransition) must mark input consumed through the current seq so the emitter in src/screen/renderer/events/emitter.ts stops delivering the committing key and its chunk-mate')
  check('the chunk-mate reached the keyboard lane NEVER (the guard)', !keyboardSaw.includes(e3.seq), `keyboard saw: ${keyboardSaw.join(',')}`, 'inputConsumedThroughSeq in src/screen/renderer/events/input-event.ts must reach the chunk-mate seq after the route commit (set by commitTransition in src/screen/routes/surfaceRoute.ts)')
  check('the committing ↵ is prior-generation to the revealed surface', sr.isPriorGenerationInput(e2.seq) && sr.isPriorGenerationInput(e3.seq), '', 'isPriorGenerationInput in src/screen/routes/surfaceRoute.ts compares against the commitSeq that commitTransition records at the flip; the committing key and its chunk-mate must be at or below it')
  w.landingResolve(true)
  await sleep(0)
  check('the hop landed BEHIND the flip (slot pointed after the commit)', w.landingSettled() && slot.hasFocusedSession(), '', 'after the landing resolves true the focused session connector in src/engine/connector/focusedConnector.ts must be set (setFocusedSessionConnector / hasFocusedSession)')
  const e4 = enterKey()
  dispatchChunk(w, [e4])
  check('a fresh post-reveal ↵ lands in the composer (zero functionality)', w.composerSaw.includes(e4.seq), '', 'a key decoded after the flip must pass the emitter in src/screen/renderer/events/emitter.ts and not count as prior generation in isPriorGenerationInput (src/screen/routes/surfaceRoute.ts)')
}

{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  const e2 = enterKey()
  dispatchChunk(w, [e2])
  const e3 = enterKey()
  dispatchChunk(w, [e3])
  check('the impatient third ↵ is NEW-generation (decoded after the commit)', !sr.isPriorGenerationInput(e3.seq), '', 'isPriorGenerationInput in src/screen/routes/surfaceRoute.ts must be false for a seq decoded after the commit (commitSeq recorded by commitTransition)')
  check(
    'it lands in the revealed composer as the operator\'s own keypress — never as a replay of the entry',
    w.composerSaw.length === 1 && w.composerSaw[0] === e3.seq,
    `saw: ${w.composerSaw.join(',')}`,
    'only the key decoded after the commit may reach the composer; check commitTransition and isPriorGenerationInput in src/screen/routes/surfaceRoute.ts',
  )
  w.landingResolve(true)
  await sleep(0)
}

{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  dispatchChunk(w, [enterKey()])
  check('flipped onto the landing', sr.currentSurfaceRoute().kind === 'repl', '', 'enterRootChat in src/screen/routes/surfaceRoute.ts must switch to the repl route while the landing is in flight')
  w.landingResolve(false)
  await sleep(0)
  check('the failed landing returned the frame to the board', sr.currentSurfaceRoute().kind === 'concourse', '', 'returnToConcourse in src/screen/routes/surfaceRoute.ts must put the frame back on the concourse route when the landing fails in the same generation')
}

{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  dispatchChunk(w, [enterKey()])
  sr.enterBootSettings()
  w.landingResolve(false)
  await sleep(0)
  check('the operator\'s later ground stands (no yank back to the board)', sr.currentSurfaceRoute().kind === 'boot-settings', '', 'surfaceGeneration in src/screen/routes/surfaceRoute.ts must advance on enterBootSettings so the failed-landing return is skipped')
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
  check('the pointer decision changes NO route (stay-in-split)', sr.currentSurfaceRoute().kind === 'concourse' && sr.surfaceGeneration() === genBefore, '', 'consumeEntryDecisionInput in src/screen/routes/surfaceRoute.ts must only mark input consumed and must not change the route or the surface generation')
  emitter.emit('input', queued)
  check('a keystroke decoded before the click dies at the emitter (the chunk law reaches the pointer lane)', !boardSaw.includes(queued.seq), '', 'consumeEntryDecisionInput in src/screen/routes/surfaceRoute.ts must mark input consumed through the current seq so the emitter in src/screen/renderer/events/emitter.ts drops the earlier keystroke')
  check(
    'the no-transition consumption re-classes nothing (the standing route\'s own handlers stay live by decode order)',
    !sr.isPriorGenerationInput(queued.seq + 1),
    '',
    'consumeEntryDecisionInput in src/screen/routes/surfaceRoute.ts must not record a commitSeq; only commitTransition does',
  )
  const after = enterKey()
  emitter.emit('input', after)
  check('the next keystroke lands on the standing surface (zero functionality)', boardSaw.includes(after.seq), '', 'the consumed seq in src/screen/renderer/events/input-event.ts must not cover a keystroke decoded after consumeEntryDecisionInput (src/screen/routes/surfaceRoute.ts)')
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
  check('the entry decision starves the neighbor of the chunk-mate (no phantom broadcast)', neighborSaw.length === 0, `neighbor saw: ${neighborSaw.join(',')}`, 'the route commit in src/screen/routes/surfaceRoute.ts must mark input consumed so the emitter in src/screen/renderer/events/emitter.ts skips later listeners for the chunk-mate')
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
  check('an entry-less ↵ reaches the neighbor untouched (nothing over-eats)', neighborSaw.includes(own.seq), '', 'with no entry decision made, the consumed seq (inputConsumedThroughSeq in src/screen/renderer/events/input-event.ts) must stay below this key so the emitter delivers it')
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
  check('input during the settled wait lands on the board (functionality preserved)', boardSaw.includes(during.seq), '', 'input before any route flip must reach the concourse listener; check the emitter in src/screen/renderer/events/emitter.ts and inputConsumedThroughSeq')
  slot.setFocusedSessionConnector({ sessionId: () => 's-settled' } as never)
  const undispatched = enterKey()
  if (sr.surfaceGeneration() === op.gen) sr.enterRootChat()
  check('the settled flip landed (the operator had not navigated)', sr.currentSurfaceRoute().kind === 'repl', '', 'enterRootChat in src/screen/routes/surfaceRoute.ts must switch to the repl route once a focused session connector is set')
  emitter.emit('input', undispatched)
  check('the queued remainder dies at the flip (aimed at a world that left)', !boardSaw.includes(undispatched.seq) && sr.isPriorGenerationInput(undispatched.seq), '', 'the flip in enterRootChat (src/screen/routes/surfaceRoute.ts) must record commitSeq and mark input consumed so a keystroke decoded before it is dropped and counted as prior generation')
  const fresh = enterKey()
  check('the next decoded keystroke is the revealed world\'s own', !sr.isPriorGenerationInput(fresh.seq), '', 'isPriorGenerationInput in src/screen/routes/surfaceRoute.ts must be false for a seq decoded after the last commit')
  sr.returnToConcourse()
  const op2 = { gen: sr.surfaceGeneration() }
  sr.enterBootSettings()
  if (sr.surfaceGeneration() === op2.gen) sr.enterRootChat()
  check('the settled leg never yanks a navigated operator', sr.currentSurfaceRoute().kind === 'boot-settings', '', 'surfaceGeneration in src/screen/routes/surfaceRoute.ts must advance on enterBootSettings so the settled flip is skipped')
}

console.log(failures === 0 ? '\nprove-swift-entry-gate: ALL LAWS HOLD' : `\nprove-swift-entry-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
