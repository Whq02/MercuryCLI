#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail && !ok ? ` — ${detail}` : ''}`)
}

const repl = read('src/screens/Chat.tsx')
const onSubmitAt = repl.indexOf('const onSubmit = useCallback(async (input: string')
const onSubmit = repl.slice(onSubmitAt, repl.indexOf('const onSubmitRef = useRef(onSubmit)'))

console.log('§1 the arm: a landing-window line takes the composer and waits as the armed message')
{
  const armAt = onSubmit.indexOf('if (landingInFlight() && !hasFocusedSession()) {')
  check('the arm reads the landing AND the empty slot (a hop with a focused session is not a landing)', armAt > 0)
  const arm = onSubmit.slice(armAt, onSubmit.indexOf('return;', armAt) + 'return;'.length)
  const armForLandingAt = onSubmit.indexOf('const armForLanding = (): void => {')
  const armForLanding = onSubmit.slice(armForLandingAt, onSubmit.indexOf('\n    };', armForLandingAt))
  check('the composer is taken once, at the arm', arm.includes('armForLanding();') && armForLandingAt > 0 && (armForLanding.match(/takeComposer\(\);/g) ?? []).length === 1)
  check('the words are armed as the initial message with the landing mark, and a line sent behind one that waits joins it', armForLanding.includes('message: createUserMessage({ content: text })') && armForLanding.includes('initialMessage: prev.initialMessage === null ? { ...line, armedAtLanding: true } : { ...prev.initialMessage, armedBehind: [...(prev.initialMessage.armedBehind ?? []), line] }'))
  check('a bash line carries its mode', armForLanding.includes("...(seatMode === 'bash' ? { bashMode: true } : {})"))
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
  check('the bash mode rides the submit and never the composer', effect.includes("armedMode: line.bashMode ? 'bash' : 'prompt'") && !effect.includes('pendingInput.setMode(') && onSubmit.includes('const seatMode = options?.armedMode ?? pendingInput.mode();'))
  check('the submit rides the rearmed word, one line after another in the order sent', effect.includes('for (const line of [armedMessage, ...(armedMessage.armedBehind ?? [])]) {') && effect.includes("await onSubmitRef.current(text, INERT_PROMPT_HELPERS, undefined, armed ? { rearmed: true, pastedContents: line.pastedContents ?? {}, armedMode: line.bashMode ? 'bash' : 'prompt' } : undefined);"))
  check('the rearmed word writes no second history entry', onSubmit.includes("if (!options?.fromKeybinding && !options?.rearmed) addToHistory("))
  check('onSubmit declares the rearmed option', repl.includes("options?: { fromKeybinding?: boolean; rearmed?: boolean; submittedAt?: string; pastedContents?: Record<number, PastedContent>; armedMode?: PromptInputMode }"))
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
