#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-submit-while-landing.ts — a line submitted while the
//  session is landing rides the armed-message road.
//
//  The class (keys typed before a screen is wired), its second seam: the
//  flip-first birth paints the chat before the seat lands, and a line
//  SUBMITTED in that window reached the resting connector, whose refusal
//  named the door the operator had already taken ("↵ New Session on the
//  boot menu starts one") and handed the words back for a second ↵. The
//  armed-message road already waits on the landing and submits at it; the
//  landing-window line now rides it.
//
//   §1  THE ARM (src/screens/REPL.tsx): a session-seat line submitted while
//       landingInFlight() && !hasFocusedSession() takes the composer once,
//       arms state.initialMessage (the words, the composer mode, the
//       landing mark), paints the landing line, and returns BEFORE the
//       send — the resting connector's sentence is never painted for it.
//   §2  THE LANDING (the armed effect): waits on the landing, carries the
//       bash mode, and submits with the rearmed word so no second history
//       entry is written.
//   §3  THE STORE (src/state/AppStateStore.ts): the two carried fields.
//   §4  THE SENTENCE the arm pre-empts is still the resting connector's
//       one honest line (unchanged owner).
//
//  cpu-pure: source pins + the connector's constant. The PTY evidence of the
//  window itself is the catalogue tripwire's typed/entered marks.
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-submit-while-landing.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

const repl = read('src/screens/REPL.tsx')
const onSubmitAt = repl.indexOf('const onSubmit = useCallback(async (input: string')
const onSubmit = repl.slice(onSubmitAt, repl.indexOf('const onSubmitRef = useRef(onSubmit)'))

console.log('§1 the arm: a landing-window line takes the composer and waits as the armed message')
{
  const armAt = onSubmit.indexOf('if (landingInFlight() && !hasFocusedSession()) {')
  check('the arm reads the landing AND the empty slot (a hop with a focused session is not a landing)', armAt > 0)
  const arm = onSubmit.slice(armAt, onSubmit.indexOf('return;', armAt) + 'return;'.length)
  check('the composer is taken once, at the arm', arm.includes('takeComposer();'))
  check('the words are armed as the initial message with the landing mark', arm.includes('initialMessage: {') && arm.includes('message: createUserMessage({ content: text })') && arm.includes('armedAtLanding: true'))
  check('a bash line carries its mode', arm.includes("...(seatMode === 'bash' ? { bashMode: true } : {})"))
  check('the footer says so', arm.includes("text: 'the session is landing — your line sends when it lands'") && arm.includes("priority: 'immediate'"))
  const sendAt = onSubmit.indexOf('.sendWords(text, {')
  check('the arm returns BEFORE the send (the resting connector never sees the line)', sendAt > armAt && arm.endsWith('return;'))
  check('the arm sits inside the session-seat branch', onSubmit.indexOf("if (seat === 'session') {") < armAt && armAt < sendAt)
}

console.log('§2 the landing: the armed effect submits the line with its mode and no second history entry')
{
  const effectAt = repl.indexOf('const armedMessage = useAppState(state => state.initialMessage);')
  const effect = repl.slice(effectAt, repl.indexOf('}, [armedMessage, landing, setAppState]);'))
  check('the effect waits on the landing', effect.includes('if (landing) return;'))
  check('the bash mode is carried into the submit', effect.includes("if (armedMessage.bashMode) pendingInput.setMode('bash');"))
  check('the submit rides the rearmed word', effect.includes("await onSubmitRef.current(text, INERT_PROMPT_HELPERS, undefined, armedMessage.armedAtLanding ? { rearmed: true } : undefined);"))
  check('the rearmed word writes no second history entry', onSubmit.includes("if (!options?.fromKeybinding && !options?.rearmed) addToHistory("))
  check('onSubmit declares the rearmed option', repl.includes("options?: { fromKeybinding?: boolean; rearmed?: boolean }"))
}

console.log('§3 the store declares the two carried fields')
{
  const store = read('src/state/AppStateStore.ts')
  const member = store.slice(store.indexOf('  initialMessage: {'), store.indexOf('  } | null', store.indexOf('  initialMessage: {')))
  check('bashMode and armedAtLanding sit on the armed message', member.includes('bashMode?: boolean') && member.includes('armedAtLanding?: boolean'))
}

console.log('§4 the resting connector keeps its one honest sentence')
{
  const resting = await import(join(ROOT, 'src/services/engine-connector/noSessionConnector.ts'))
  check('the sentence names the door a chat starts through (unchanged owner)', resting.NO_CHAT_OPEN === 'no chat is open — ↵ New Session on the boot menu starts one')
  const refused = await new resting.NoSessionConnector().sendWords()
  check('the resting connector still refuses a send with it (the arm is what keeps a landing line away from it)', refused.state === 'refused' && refused.detail === resting.NO_CHAT_OPEN)
}

if (failures > 0) {
  console.log(`\n ❌ submit-while-landing — ${failures} failure(s)`)
  process.exit(1)
}
console.log('\n ✅ submit-while-landing — a landing-window line waits as the armed message and sends when the seat lands')
