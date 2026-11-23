#!/usr/bin/env bun
import { mock } from 'bun:test'
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'
import { mountPart } from './chatScenarios.ts'

const HOME = pinScratchHome('chat-title-part')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

const sleep: string[] = []
mock.module('../../src/platform/host-os/preventSleep.ts', () => ({
  startPreventSleep: () => void sleep.push('start'),
  stopPreventSleep: () => void sleep.push('stop'),
}))

const React = await import('react')
const { AnimatedTitle, useChatTitle } = await import('../../src/screen/chat/useChatTitle.tsx')
const { getCockpitActivity, resetCockpitActivityForTests } = await import('../../src/screen/cockpit/cockpitActivity.ts')
const { pushOverlay, popOverlay, resetOverlayStackForTests } = await import('../../src/screen/overlays/overlayStack.ts')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { getSessionId } = await import('../../src/boot/process-state/processState.ts')
const { restoreSessionMetadata } = await import('../../src/sessions/transcripts/sessionListings.ts')
const { ClockContext } = await import('../../src/screen/renderer/elements/ClockContext.tsx')
type Args = Parameters<typeof useChatTitle>[0]

const other = Object.assign(new NoSessionConnector(), { sessionId: () => 'another-session' })
const own = Object.assign(new NoSessionConnector(), { sessionId: () => String(getSessionId()) })

const T = 'src/screen/chat/useChatTitle.tsx'
section('§1 the hook alone, with planted arguments: the title it hands on')
resetCockpitActivityForTests()
resetOverlayStackForTests()
const planted = (over: Partial<Args>) => (store: Args['store']): ReturnType<typeof useChatTitle> =>
  useChatTitle({ focusedInputDialog: undefined, focusedConnector: other as never, isLoading: false, store, ...over })
const part = await mountPart(planted({}))
check('with no session title and no agent the title is the product name', part.value().title === 'Mercury', `${part.value().title} · useChatTitle in ${T} should fall back to 'Mercury' when there is no session title and no agent name`)
check('an idle screen does not animate its title', part.value().titleAnimating === false, `titleAnimating in useChatTitle (${T}) must be isLoading with no dialog; it was true on an idle screen`)
restoreSessionMetadata({ customTitle: 'the gate lane' } as never)
await part.set(planted({ focusedConnector: own as never }))
check("the focused session's own title is the title", part.value().title === 'the gate lane', `${part.value().title} · useChatTitle (${T}) should read getCurrentSessionTitle for the focused connector's own session id`)
await part.set(planted({ focusedConnector: other as never }))
check("another session's connector does not borrow this session's title", part.value().title === 'Mercury', `${part.value().title} · useChatTitle (${T}) must look the title up by focusedConnector.sessionId(), not the current session`)
part.store().setState(prev => ({ ...prev, standaloneAgentContext: { name: 'reviewer' } }))
await part.set(planted({}))
check('a standalone agent names the title when the session has none', part.value().title === 'reviewer', `${part.value().title} · useChatTitle (${T}) should use standaloneAgentContext.name when the session has no title`)
part.store().setState(prev => ({ ...prev, standaloneAgentContext: undefined, settings: { ...prev.settings, terminalTitle: { sessionTitle: false } } as never }))
await part.set(planted({ focusedConnector: own as never }))
check('with the session title switched off in the settings the title is the product name again', part.value().title === 'Mercury' && part.value().sessionTitleSetting === false, `${part.value().title} · ${String(part.value().sessionTitleSetting)} · useChatTitle (${T}) must ignore the session title when settings.terminalTitle.sessionTitle is false`)

section('§2 the hook alone: when the title animates, the machine is kept awake')
sleep.length = 0
await part.set(planted({ isLoading: true }))
check('a running turn animates the title', part.value().titleAnimating === true, `useChatTitle (${T}) should set titleAnimating when isLoading with no dialog`)
check('and sleep prevention starts once', sleep.join(',') === 'start', `${sleep.join(',')} · useChatTitle (${T}) should call startPreventSleep once, from its useClaim on titleAnimating`)
await part.set(planted({ isLoading: true, focusedInputDialog: 'tool-permission' }))
check('a permission card over the running turn stops the animation', part.value().titleAnimating === false, `useChatTitle (${T}) must clear titleAnimating when focusedInputDialog is 'tool-permission'`)
check('and sleep prevention stops', sleep.join(',') === 'start,stop', `${sleep.join(',')} · the useClaim cleanup in useChatTitle (${T}) should call stopPreventSleep when the animation stops`)
await part.set(planted({ isLoading: true, focusedInputDialog: 'cost-threshold' }))
check('a local dialog over the running turn keeps the animation stopped and starts nothing', part.value().titleAnimating === false && sleep.join(',') === 'start,stop', `${sleep.join(',')} · useChatTitle (${T}) showingLocalDialog must keep titleAnimating false`)
await part.set(planted({ isLoading: true }))
await part.set(planted({ isLoading: false }))
check('the turn resumed and ended: one more start and one more stop', sleep.join(',') === 'start,stop,start,stop', `${sleep.join(',')} · useChatTitle (${T}) should pair one startPreventSleep with one stopPreventSleep per animating stretch`)

section('§3 the hook alone: the activity word it publishes for the cockpit')
await part.set(planted({}))
check('an idle screen publishes calm', getCockpitActivity() === 'calm', `${getCockpitActivity()} · useChatTitle (${T}) should publish 'calm' via publishCockpitActivity when idle`)
await part.set(planted({ isLoading: true }))
check('a running turn publishes active', getCockpitActivity() === 'active', `${getCockpitActivity()} · useChatTitle (${T}) should publish 'active' while isLoading`)
const review = pushOverlay({ id: 'diff-dialog', modal: true })
await part.set(planted({ isLoading: true }))
check('an open diff review outranks running work', getCockpitActivity() === 'review', `${getCockpitActivity()} · useChatTitle (${T}) should publish 'review' while the 'diff-dialog' overlay is open`)
await part.set(planted({ isLoading: true, focusedInputDialog: 'tool-permission' }))
check('a pending decision outranks the review and the running work', getCockpitActivity() === 'waiting', `${getCockpitActivity()} · cockpitActivity in useChatTitle (${T}) must rank 'waiting' above 'review' and 'active'`)
popOverlay(review)
await part.set(planted({ isLoading: true, focusedInputDialog: 'tool-permission' }))
check('and still stands with the review closed', getCockpitActivity() === 'waiting', `${getCockpitActivity()} · useChatTitle (${T}) should keep 'waiting' while the tool-permission dialog is focused`)
await part.set(planted({ isLoading: true, focusedInputDialog: 'message-selector' }))
check('a dialog that is no permission card leaves the running turn active', getCockpitActivity() === 'active', `${getCockpitActivity()} · useChatTitle (${T}) should treat only 'tool-permission' as 'waiting'`)
part.unmount()

section('§4 the title component alone: what it writes to the terminal')
const titlesOf = (writes: string[]): string[] =>
  writes.flatMap(data => [...data.matchAll(/\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map(found => found[1]!))
type TitleProps = { enabled: boolean; title: string; wantsPrefix: boolean; animating: boolean }
let props: TitleProps = { enabled: true, title: 'Mercury', wantsPrefix: true, animating: false }
let clockKept = false
function ClockKeeper(): null {
  const clock = React.useContext(ClockContext)
  React.useEffect(() => (clockKept && clock ? clock.subscribe(() => {}, true) : undefined), [clock, clockKept])
  return null
}
const drawn = await mountPart(() => props, { draw: value => React.createElement(React.Fragment, null, React.createElement(ClockKeeper), React.createElement(AnimatedTitle, value)) })
check('a still title is written with the static mark', titlesOf(drawn.writes).at(-1) === '✻ Mercury', `${JSON.stringify(titlesOf(drawn.writes))} · AnimatedTitle passes "✻ title" to useTerminalTitle when not animating in src/screen/chat/useChatTitle.tsx`)
props = { ...props, animating: true }
await drawn.set(() => props)
check('an animating title is written with the first frame', titlesOf(drawn.writes).at(-1) === '⠂ Mercury', `${JSON.stringify(titlesOf(drawn.writes))} · AnimatedTitle should use TITLE_FRAMES[0] as the first frame in src/screen/chat/useChatTitle.tsx`)
await settle(1100)
check('with nothing else on the clock the title does not step by itself', titlesOf(drawn.writes).at(-1) === '⠂ Mercury', `${JSON.stringify(titlesOf(drawn.writes))} · AnimatedTitle's useInterval should step only while the clock is kept running in src/screen/chat/useChatTitle.tsx`)
clockKept = true
await drawn.set(() => props)
await settle(1200)
check('with the clock kept running it steps to the second frame', titlesOf(drawn.writes).includes('⠐ Mercury'), `${JSON.stringify(titlesOf(drawn.writes))} · AnimatedTitle's useInterval (TITLE_INTERVAL_MS) should advance the frame in src/screen/chat/useChatTitle.tsx`)
clockKept = false
props = { ...props, animating: false, wantsPrefix: false, title: 'plain' }
await drawn.set(() => props)
check('a title that wants no prefix is written bare', titlesOf(drawn.writes).at(-1) === 'plain', `${JSON.stringify(titlesOf(drawn.writes))} · AnimatedTitle should pass the bare title when wantsPrefix is false in src/screen/chat/useChatTitle.tsx`)
const before = titlesOf(drawn.writes).length
props = { ...props, enabled: false, title: 'never written' }
await drawn.set(() => props)
check('a disabled title writes nothing', titlesOf(drawn.writes).length === before, `${JSON.stringify(titlesOf(drawn.writes))} · AnimatedTitle should pass null to useTerminalTitle when enabled is false in src/screen/chat/useChatTitle.tsx`)
drawn.unmount()

await releaseScratchHome(HOME)
console.log(`\n${failures === 0 ? 'prove-chat-title-part: ALL PASS' : `prove-chat-title-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
