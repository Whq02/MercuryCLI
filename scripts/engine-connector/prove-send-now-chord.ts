#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 300)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const chord = await import('../../src/input-core/sendNowChord.ts')
const bar = await import('../../src/components/SwitchboardTagBar.tsx')
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { resolveKeyWithChordState } = await import('../../src/keybindings/resolver.ts')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
const { parseBindings } = await import('../../src/keybindings/parser.ts')
const { DAEMON_VERB_BORN_AT, MERCURY_DAEMON_PROTO, verbBornAt } = await import('../../src/daemon/protocol.ts')
const { METHODS } = await import('../../src/runner/wire/methods.ts')

type Live = typeof IDLE_LIVE
const live = (inFlight: boolean): Live => ({ ...IDLE_LIVE, inFlight, phase: inFlight ? 'tool' : 'idle', inProgressToolUseIDs: new Set(inFlight ? ['toolu_1'] : []) })
const status = (interrupting = false, hardStopping = false): { interrupting: boolean; hardStopping: boolean } => ({ interrupting, hardStopping })

section('§1 the chord — ctrl+s twice within two seconds, only while the agent waits on a tool with a sent line behind it')
check('the window is two seconds and the hint is the owner\'s spelling', chord.SEND_NOW_WINDOW_MS === 2_000 && chord.SEND_NOW_HINT === 'ctrl+s s sends now', `${chord.SEND_NOW_WINDOW_MS} · ${chord.SEND_NOW_HINT}`)
chord.disarmSendNow()
check('one ctrl+s alone arms and does nothing', chord.pressSendNow(true, 10_000) === false)
check('the second ctrl+s inside two seconds sends now', chord.pressSendNow(true, 11_500) === true)
check('a third press starts over: it arms again, it does not fire', chord.pressSendNow(true, 11_600) === false)
chord.disarmSendNow()
check('two presses three seconds apart do nothing (the second re-arms)', chord.pressSendNow(true, 20_000) === false && chord.pressSendNow(true, 23_001) === false)
check('…and the press after that one, inside the window, fires', chord.pressSendNow(true, 24_000) === true)
chord.disarmSendNow()
check('with nothing to send the chord is inert and never arms', chord.pressSendNow(false, 30_000) === false && chord.pressSendNow(false, 30_500) === false && chord.pressSendNow(true, 31_000) === false)
check('a press while inert disarms a half-made chord', chord.pressSendNow(true, 40_000) === false && chord.pressSendNow(false, 40_500) === false && chord.pressSendNow(true, 41_000) === false)
chord.disarmSendNow()

section('§2 the facts — a turn in flight, inside a tool call, with a sent line waiting')
check('all three facts make the chord live', chord.sendNowLive({ inFlight: true, toolsInFlight: 1, queuedSends: 1 }))
check('two crewmates and two lines: live', chord.sendNowLive({ inFlight: true, toolsInFlight: 2, queuedSends: 2 }))
check('no sent line waiting: inert', !chord.sendNowLive({ inFlight: true, toolsInFlight: 1, queuedSends: 0 }))
check('the model streaming, no tool in flight: inert (the line lands at the next boundary on its own)', !chord.sendNowLive({ inFlight: true, toolsInFlight: 0, queuedSends: 1 }))
check('idle: inert', !chord.sendNowLive({ inFlight: false, toolsInFlight: 0, queuedSends: 1 }))

section('§3 the status row — the one new clause, painted only while the chord is live')
check('a tool wait with a sent line behind it: esc interrupts · ctrl+s s sends now · ⇧← back', bar.escBackHint(live(true), status(), false, true) === keyHintLabel('esc interrupts · ctrl+s s sends now · ⇧← back'), bar.escBackHint(live(true), status(), false, true))
check('a shell wait with a sent line behind it: esc interrupts · ⇧b backgrounds · ctrl+s s sends now · ⇧← back', bar.escBackHint(live(true), status(), true, true) === keyHintLabel('esc interrupts · ⇧b backgrounds · ctrl+s s sends now · ⇧← back'), bar.escBackHint(live(true), status(), true, true))
check('no sent line: the row reads as shipped', bar.escBackHint(live(true), status(), false, false) === keyHintLabel('esc interrupts · ⇧← back') && bar.escBackHint(live(true), status()) === keyHintLabel('esc interrupts · ⇧← back'))
check('interrupting: the clause goes with the interrupt rung', bar.escBackHint(live(true), status(true), false, true) === keyHintLabel('esc again re-sends the interrupt · ⇧← back'))
check('idle: ⇧← back alone whatever the chord fact says', bar.escBackHint(live(false), status(), false, true) === keyHintLabel('⇧← back'))

section('§4 the key — ctrl+s stays the stash binding; the chord rides its second press, never a two-step binding that would shadow it')
const bindings = parseBindings(DEFAULT_BINDINGS)
const ctrlS = { ctrl: true, meta: false, shift: false, escape: false, super: false, upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, return: false, backspace: false, delete: false, tab: false, pageDown: false, pageUp: false } as never
const single = resolveKeyWithChordState('s', ctrlS, ['Chat', 'Global'] as never[], bindings, null)
check('one ctrl+s in the Chat resolves to chat:stash at once (no chord starts, so the stash never waits)', single.type === 'match' && single.action === 'chat:stash', JSON.stringify(single))
check('no default binding opens a two-step chord on ctrl+s (the resolver gives a longer chord the key and the stash would never fire)', !bindings.some(b => b.chord.length > 1 && b.chord[0]!.key === 's' && b.chord[0]!.ctrl))
const chat = Object.assign({}, ...(DEFAULT_BINDINGS as { context: string; bindings: Record<string, string> }[]).filter(b => b.context === 'Chat').map(b => b.bindings)) as Record<string, string>
check('the default Chat binding of ctrl+s is the stash', chat['ctrl+s'] === 'chat:stash', JSON.stringify(chat['ctrl+s']))
const composer = read('src/components/PromptInput/useComposerKeybindings.ts')
check('the stash handler asks the latch first: the second press sends now, every other press stashes as today', composer.includes("'chat:stash': () => {\n        if (pressSendNow(focusedSendNowLive())) {\n          void sendFocusedWordsNow().then(receipt => {") && composer.includes('          return\n        }\n        performStash()\n      },'))
check('fold 46ai: an applied send paints nothing; a refusal preserves its way out on the notice row', composer.includes("if (receipt.outcome === 'applied') return") && composer.includes("addNotification({ key: 'send-now', ...splitWayOut(receipt.detail ?? 'no reason given'), priority: 'immediate' })"))
const reserved = read('src/keybindings/reservedShortcuts.ts')
check('ctrl+s is not a terminal-reserved key here: the product owns it (flow control is off in the terminals it runs in)', !/key: 'ctrl\+[sq]'/.test(reserved))

section('§5 the road — the cockpit fact, the connector verb, the daemon action, the runner method')
const fact = read('src/services/engine-connector/sendNowLive.ts')
check('the focused fact reads the live turn, its in-progress tools and the connector\'s queued sends, and subscribes to records and live', fact.includes('sendNowLive({ inFlight: live.inFlight, toolsInFlight: live.inProgressToolUseIDs.size, queuedSends: connector.queuedSendCount() })') && fact.includes('const records = connector.subscribeRecords(listener)') && fact.includes("hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {}"))
const connector = read('src/services/engine-connector/daemonConnector.ts')
check('the connector counts a sent line as queued only while the runner\'s queue holds it, not held for a fold, not withdrawing, never a crew notice', connector.includes("if (s.state === 'queued' && s.heldFor === undefined && s.withdrawing !== true && !isNoticeKey(s.clientMessageId)) count += 1"))
check('the connector\'s verb is the seat\'s send-now action on the verb chain', connector.includes("const reply = await this.chainRpc({ op: 'sessionControl', action: 'send-now', sessionId: this.record.sessionId, by: 'operator' })"))
const noSession = read('src/services/engine-connector/noSessionConnector.ts')
check('no chat open: the verb refuses with the one sentence and counts nothing', noSession.includes('async sendNow(): Promise<AgentControlReceiptV1> {\n    return { outcome: \'refused\', detail: NO_CHAT_OPEN }') && noSession.includes('queuedSendCount(): number {\n    return 0'))
check('the daemon verb sessionControl/send-now is born at proto 18, the wire\'s current proto', DAEMON_VERB_BORN_AT['sessionControl/send-now'] === 18 && verbBornAt('sessionControl', 'send-now') === 18 && MERCURY_DAEMON_PROTO === 18)
const server = read('src/daemon/controlServer.ts')
check('the control server admits the action and names it in its refusal', server.includes("raw.action === 'send-now'") && /requires \{ action: [^']*\|send-now(\|[a-z-]+)*, sessionId, by \}/.test(server))
const main = read('src/daemon/main.ts')
check('the daemon relays the action to the seat verb', main.includes("if (action === 'send-now')") && main.includes('return sendSessionNow(sessionId, roster)'))
const seat = read('src/daemon/sessionSeat.ts')
check('the seat asks session/send_now through the runner door and awaits its word', seat.includes("askSeat(roster, rec.runnerId, 'session/send_now', {}, 'send-now', deadlineMs)") && seat.includes('export async function sendSessionNow('))
check('a runner older than the verb is refused in one sentence naming the key and the way out', seat.includes(`"this session's runner predates ctrl+s s · /daemon restart, then reopen the session"`))
check('the wire declares session/send_now as a host request with no params and the four counts', METHODS['session/send_now'].from === 'host' && METHODS['session/send_now'].kind === 'request' && METHODS['session/send_now'].params().safeParse({}).success && METHODS['session/send_now'].result().safeParse({ queued: 1, released: 0, crewmates: 2, shells: 1 }).success && !METHODS['session/send_now'].result().safeParse({ queued: 1 }).success)
const tag = read('src/components/SwitchboardTagBar.tsx')
check('the status row reads the chord fact beside the shell fact', tag.includes('const sendNow = useFocusedSendNowLive()') && tag.includes('escBackHint(live, status, shellRunning && getSettingsSnapshot().settings.view?.backgroundKey !== false, sendNow)'))

console.log(`\n${failures === 0 ? 'ALL LAWS HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
