#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-swift-entry-gate.ts — THE NO-PHANTOM-INPUT
//  invariant (SWIFT C1): a board row's confirming ↵ commits the surface
//  transition IN THE COMMITTING EVENT'S DISPATCH, so the committing enter
//  and every event queued behind it in the same chunk die at the law's own
//  watermark — a doubled ↵ can never leak through the transition into the
//  revealed composer and mint a send, a queue entry, or a steer.
//
//  Two layers, the atomic-session-switch pattern:
//   §1 SOURCE: the entry road's ordering is structural — the landing is
//      armed synchronously and the commit precedes the async hop body in
//      attachAndEnter; the 'settled' continuation legs are marked; the
//      keyboard lane is watermark-guarded; the composer ladder declines
//      prior-generation events.
//   §2 MECHANISM, driven on the REAL law modules (surfaceRoute store,
//      the ink emitter, InputEvent seqs, the focusedConnector landing
//      gate) with the entry decision shaped exactly as §1 pins the source:
//      ↵↵ in ONE chunk (App.tsx's own per-chunk loop, replicated
//      byte-for-byte) and ↵↵↵ across chunks mint ZERO composer
//      observations of old-generation input; the landing lands behind the
//      flip; a failed landing restores the board under the yank law.
//
//  cpu-pure: no PTY, no daemon, no Mercury boot.
// ============================================================================
import { readFileSync } from 'node:fs'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── §1 the source ordering ──────────────────────────────────────────────────
console.log('§1 the entry road commits in the committing dispatch (source)')
const route = readFileSync('src/components/concourse/ConcourseRoute.tsx', 'utf8')
const attachStart = route.indexOf('const attachAndEnter = useCallback(')
const attachEnd = route.indexOf('const waitingRoomAdmitted', attachStart)
const attach = route.slice(attachStart, attachEnd > attachStart ? attachEnd : attachStart + 8000)
check('attachAndEnter found', attachStart >= 0)

const landingAt = attach.indexOf('const landing = withLanding(')
const commitAt = attach.indexOf('consumeEntryDecisionInput()')
const flipAt = attach.indexOf('enterRootRepl().ok')
const asyncBodyAt = attach.indexOf('void (async () => {')
check(
  'the landing is armed synchronously (withLanding before the async body)',
  landingAt >= 0 && asyncBodyAt > landingAt,
)
check(
  'the split leg consumes at the decision, before the async body',
  commitAt > landingAt && commitAt < asyncBodyAt,
)
check(
  'the flip leg commits at the decision, before the async body',
  flipAt > landingAt && flipAt < asyncBodyAt,
)
check(
  "the failure leg returns the frame to the board under the yank law",
  attach.includes('surfaceGeneration() === flippedGen) returnToConcourse()'),
)
check(
  "the 'settled' legs keep the landed late flip (yank guard + flip in the async body)",
  attach.indexOf('surfaceGeneration() === op.gen') > asyncBodyAt,
)
check(
  "the waiting-room admit and the obligation door enter as 'settled' continuations",
  /attachAndEnter\(sessionId, 'board:open', \{ entry: 'settled' \}\)/.test(route) &&
    /attachAndEnter\(row\.sessionId, 'board:open', \{ fullChat: true, entry: 'settled' \}\)/.test(route),
)

const app = readFileSync('src/ink/components/App.tsx', 'utf8')
const emitAt = app.indexOf("this.internal_eventEmitter.emit('input', event)")
const guardAt = app.indexOf('chunkConsumed = true\n        continue', emitAt)
const keyboardAt = app.indexOf('this.props.dispatchKeyboardEvent(atom)', emitAt)
check(
  'the keyboard lane is watermark-guarded (a commit mid-emit reaches no further lane)',
  emitAt >= 0 && guardAt > emitAt && keyboardAt > guardAt,
)

const prompt = readFileSync('src/components/PromptInput/PromptInput.tsx', 'utf8')
check(
  "the composer ladder declines prior-generation events (SR-022's consumer)",
  prompt.includes('event.seq !== undefined && isPriorGenerationInput(event.seq)) return'),
)

const surfaceRoute = readFileSync('src/context/surfaceRoute.ts', 'utf8')
check(
  'the no-transition consumption door lives with the route owner',
  surfaceRoute.includes('export function consumeEntryDecisionInput()'),
)

// ── §2 the mechanism, driven ────────────────────────────────────────────────
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

/** One fresh world per walk: concourse current, chat presence riding the
 *  REAL slot+landing seam (SurfaceRouter's own registration shape), a board
 *  handler running THE FIXED entry decision (§1 pins the product source to
 *  this exact ordering), and a composer spy beneath riding the same
 *  prior-generation decline the ladder carries. */
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
  // The composer beneath (registered FIRST, like the product's REPL): live
  // exactly while the repl owns the frame, decline prior-generation events
  // (the ladder's 1b gate).
  emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind !== 'repl') return
    if (sr.isPriorGenerationInput(e.seq)) return
    if (e.key.return) composerSaw.push(e.seq)
  })
  // The board handler: arm-then-enter; the second ↵ runs the FIXED entry
  // decision — synchronous landing arm + in-dispatch commit; the hop lands
  // behind (resolved by the walk).
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
    const flipped = sr.enterRootRepl().ok ? sr.surfaceGeneration() : null
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

/** App.tsx's per-chunk dispatch loop, replicated byte-for-byte (emit → the
 *  watermark guard → the keyboard lane placeholder → the tail check). */
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

// — walk 1: ↵↵ in ONE chunk (the fast double-tap) —
{
  const w = armWorld()
  const keyboardSaw: number[] = []
  const e1 = enterKey()
  const e2 = enterKey()
  const e3 = enterKey()
  dispatchChunk(w, [e1], keyboardSaw) // arm
  dispatchChunk(w, [e2, e3], keyboardSaw) // enter + the chunk-mate
  check('the confirming ↵ committed in its own dispatch (route = repl at chunk end)', sr.currentSurfaceRoute().kind === 'repl')
  check('the chat was in flight at the flip (the landing armed synchronously)', sr.chatPresent())
  check('the committing ↵ and its chunk-mate reached the composer NEVER', w.composerSaw.length === 0, `saw: ${w.composerSaw.join(',')}`)
  check('the chunk-mate reached the keyboard lane NEVER (the guard)', !keyboardSaw.includes(e3.seq), `keyboard saw: ${keyboardSaw.join(',')}`)
  check('the committing ↵ is prior-generation to the revealed surface', sr.isPriorGenerationInput(e2.seq) && sr.isPriorGenerationInput(e3.seq))
  w.landingResolve(true)
  await sleep(0)
  check('the hop landed BEHIND the flip (slot pointed after the commit)', w.landingSettled() && slot.hasFocusedSession())
  // A genuinely new ↵ after the reveal is the operator's own — it lands.
  const e4 = enterKey()
  dispatchChunk(w, [e4])
  check('a fresh post-reveal ↵ lands in the composer (zero functionality)', w.composerSaw.includes(e4.seq))
}

// — walk 2: ↵↵↵ across chunks (the impatient triple) —
{
  const w = armWorld()
  dispatchChunk(w, [enterKey()]) // arm
  const e2 = enterKey()
  dispatchChunk(w, [e2]) // enter — commit lands here
  const e3 = enterKey()
  dispatchChunk(w, [e3]) // the impatient third, its own chunk
  check('the impatient third ↵ is NEW-generation (decoded after the commit)', !sr.isPriorGenerationInput(e3.seq))
  check(
    'it lands in the revealed composer as the operator\'s own keypress — never as a replay of the entry',
    w.composerSaw.length === 1 && w.composerSaw[0] === e3.seq,
    `saw: ${w.composerSaw.join(',')}`,
  )
  w.landingResolve(true)
  await sleep(0)
}

// — walk 3: the failed landing restores the board (the yank law) —
{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  dispatchChunk(w, [enterKey()])
  check('flipped onto the landing', sr.currentSurfaceRoute().kind === 'repl')
  w.landingResolve(false)
  await sleep(0)
  check('the failed landing returned the frame to the board', sr.currentSurfaceRoute().kind === 'concourse')
}

// — walk 4: the failed landing NEVER yanks an operator who navigated —
{
  const w = armWorld()
  dispatchChunk(w, [enterKey()])
  dispatchChunk(w, [enterKey()])
  sr.enterBootSettings() // the operator moved on before the landing settled
  w.landingResolve(false)
  await sleep(0)
  check('the operator\'s later ground stands (no yank back to the board)', sr.currentSurfaceRoute().kind === 'boot-settings')
}

// ── §3 the gate's edges (SWIFTVERIFY V1 — the other input lanes) ────────────
console.log('\n§3 the edges (pointer entry · the ↵ neighbors · the settled leg)')

// — walk 5: the POINTER entry on the stay-in-split leg — the click is an
//   input-world event (the mouse bump), the decision consumes in its own
//   dispatch, the route holds, and the standing surface's handlers stay
//   live for the next keystroke (the documented no-re-classing divergence).
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
  const queued = enterKey() // decoded BEFORE the click, not yet dispatched
  inputEvent.bumpInputEventSeqForMouse() // the click itself
  const genBefore = sr.surfaceGeneration()
  sr.consumeEntryDecisionInput() // the pointer decision (stay-in-split)
  check('the pointer decision changes NO route (stay-in-split)', sr.currentSurfaceRoute().kind === 'concourse' && sr.surfaceGeneration() === genBefore)
  emitter.emit('input', queued)
  check('a keystroke decoded before the click dies at the emitter (the chunk law reaches the pointer lane)', !boardSaw.includes(queued.seq))
  check(
    'the no-transition consumption re-classes nothing (the standing route\'s own handlers stay live by decode order)',
    !sr.isPriorGenerationInput(queued.seq + 1),
  )
  const after = enterKey() // decoded after the decision
  emitter.emit('input', after)
  check('the next keystroke lands on the standing surface (zero functionality)', boardSaw.includes(after.seq))
}

// — walk 6: the board's ↵ NEIGHBORS (broadcast send, the answer door) — the
//   entry decision kills its own chunk-mates for every listener beneath it,
//   and an entry-less chunk reaches the neighbor untouched.
{
  const w = armWorld()
  const neighborSaw: number[] = []
  // The neighbor door registered beneath the entry handler (the broadcast
  // send's shape): it hears board-world ↵ that nothing consumed first.
  w.emitter.on('input', (e: InstanceType<typeof InputEvent>) => {
    if (sr.currentSurfaceRoute().kind !== 'concourse' || !e.key.return) return
    neighborSaw.push(e.seq)
  })
  dispatchChunk(w, [enterKey()]) // arm (the entry handler consumes it)
  const e2 = enterKey()
  const mate = enterKey()
  dispatchChunk(w, [e2, mate]) // the entry ↵ + a chunk-mate
  check('the entry decision starves the neighbor of the chunk-mate (no phantom broadcast)', neighborSaw.length === 0, `neighbor saw: ${neighborSaw.join(',')}`)
  w.landingResolve(true)
  await sleep(0)
}
// …and with NO entry in the world (the broadcast door standing alone), its
// own ↵ arrives untouched — the watermark never over-eats.
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
  check('an entry-less ↵ reaches the neighbor untouched (nothing over-eats)', neighborSaw.includes(own.seq))
}

// — walk 7: the SETTLED continuation leg (waiting-room admit, obligation
//   door): input during the wait lands on the board; the late flip consumes
//   only the queued remainder; the yank law spares a navigated operator.
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
  // The admit arrives from the daemon (no keystroke, no consumption) —
  // the operator keeps working the board while the landing is in flight.
  const during = enterKey()
  emitter.emit('input', during)
  check('input during the settled wait lands on the board (functionality preserved)', boardSaw.includes(during.seq))
  slot.setFocusedSessionConnector({ sessionId: () => 's-settled' } as never)
  const undispatched = enterKey() // decoded, still queued when the flip lands
  if (sr.surfaceGeneration() === op.gen) sr.enterRootRepl() // the settled late flip (the yank guard held)
  check('the settled flip landed (the operator had not navigated)', sr.currentSurfaceRoute().kind === 'repl')
  emitter.emit('input', undispatched)
  check('the queued remainder dies at the flip (aimed at a world that left)', !boardSaw.includes(undispatched.seq) && sr.isPriorGenerationInput(undispatched.seq))
  const fresh = enterKey()
  check('the next decoded keystroke is the revealed world\'s own', !sr.isPriorGenerationInput(fresh.seq))
  // The yank law on the same leg: a navigated operator is never dragged.
  sr.returnToConcourse()
  const op2 = { gen: sr.surfaceGeneration() }
  sr.enterBootSettings() // the operator moved before the admit's continuation ran
  if (sr.surfaceGeneration() === op2.gen) sr.enterRootRepl()
  check('the settled leg never yanks a navigated operator', sr.currentSurfaceRoute().kind === 'boot-settings')
}

console.log(failures === 0 ? '\nprove-swift-entry-gate: ALL LAWS HOLD' : `\nprove-swift-entry-gate: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
