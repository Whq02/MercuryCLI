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
mock.module('../../src/services/preventSleep.ts', () => ({
  startPreventSleep: () => void sleep.push('start'),
  stopPreventSleep: () => void sleep.push('stop'),
}))

const React = await import('react')
const { AnimatedTitle, useChatTitle } = await import('../../src/screens/chat/useChatTitle.tsx')
const { getCockpitActivity, resetCockpitActivityForTests } = await import('../../src/utils/cockpit/cockpitActivity.ts')
const { pushOverlay, popOverlay, resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
const { NoSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { restoreSessionMetadata } = await import('../../src/utils/sessionStorage/logs.ts')
const { ClockContext } = await import('../../src/ink/components/ClockContext.tsx')
type Args = Parameters<typeof useChatTitle>[0]

const other = Object.assign(new NoSessionConnector(), { sessionId: () => 'another-session' })
const own = Object.assign(new NoSessionConnector(), { sessionId: () => String(getSessionId()) })

section('§1 the hook alone, with planted arguments: the title it hands on')
resetCockpitActivityForTests()
resetOverlayStackForTests()
const planted = (over: Partial<Args>) => (store: Args['store']): ReturnType<typeof useChatTitle> =>
  useChatTitle({ focusedInputDialog: undefined, focusedConnector: other as never, isLoading: false, store, ...over })
const part = await mountPart(planted({}))
check('with no session title and no agent the title is the product name', part.value().title === 'Mercury', part.value().title)
check('an idle screen does not animate its title', part.value().titleAnimating === false)
restoreSessionMetadata({ customTitle: 'the gate lane' } as never)
await part.set(planted({ focusedConnector: own as never }))
check("the focused session's own title is the title", part.value().title === 'the gate lane', part.value().title)
await part.set(planted({ focusedConnector: other as never }))
check("another session's connector does not borrow this session's title", part.value().title === 'Mercury', part.value().title)
part.store().setState(prev => ({ ...prev, standaloneAgentContext: { name: 'reviewer' } }))
await part.set(planted({}))
check('a standalone agent names the title when the session has none', part.value().title === 'reviewer', part.value().title)
part.store().setState(prev => ({ ...prev, standaloneAgentContext: undefined, settings: { ...prev.settings, terminalTitle: { sessionTitle: false } } as never }))
await part.set(planted({ focusedConnector: own as never }))
check('with the session title switched off in the settings the title is the product name again', part.value().title === 'Mercury' && part.value().sessionTitleSetting === false, `${part.value().title} · ${String(part.value().sessionTitleSetting)}`)

section('§2 the hook alone: when the title animates, the machine is kept awake')
sleep.length = 0
await part.set(planted({ isLoading: true }))
check('a running turn animates the title', part.value().titleAnimating === true)
check('and sleep prevention starts once', sleep.join(',') === 'start', sleep.join(','))
await part.set(planted({ isLoading: true, focusedInputDialog: 'tool-permission' }))
check('a permission card over the running turn stops the animation', part.value().titleAnimating === false)
check('and sleep prevention stops', sleep.join(',') === 'start,stop', sleep.join(','))
await part.set(planted({ isLoading: true, focusedInputDialog: 'cost-threshold' }))
check('a local dialog over the running turn keeps the animation stopped and starts nothing', part.value().titleAnimating === false && sleep.join(',') === 'start,stop', sleep.join(','))
await part.set(planted({ isLoading: true }))
await part.set(planted({ isLoading: false }))
check('the turn resumed and ended: one more start and one more stop', sleep.join(',') === 'start,stop,start,stop', sleep.join(','))

section('§3 the hook alone: the activity word it publishes for the cockpit')
await part.set(planted({}))
check('an idle screen publishes calm', getCockpitActivity() === 'calm', getCockpitActivity())
await part.set(planted({ isLoading: true }))
check('a running turn publishes active', getCockpitActivity() === 'active', getCockpitActivity())
const review = pushOverlay({ id: 'diff-dialog', modal: true })
await part.set(planted({ isLoading: true }))
check('an open diff review outranks running work', getCockpitActivity() === 'review', getCockpitActivity())
await part.set(planted({ isLoading: true, focusedInputDialog: 'tool-permission' }))
check('a pending decision outranks the review and the running work', getCockpitActivity() === 'waiting', getCockpitActivity())
popOverlay(review)
await part.set(planted({ isLoading: true, focusedInputDialog: 'tool-permission' }))
check('and still stands with the review closed', getCockpitActivity() === 'waiting', getCockpitActivity())
await part.set(planted({ isLoading: true, focusedInputDialog: 'message-selector' }))
check('a dialog that is no permission card leaves the running turn active', getCockpitActivity() === 'active', getCockpitActivity())
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
check('a still title is written with the static mark', titlesOf(drawn.writes).at(-1) === '✻ Mercury', JSON.stringify(titlesOf(drawn.writes)))
props = { ...props, animating: true }
await drawn.set(() => props)
check('an animating title is written with the first frame', titlesOf(drawn.writes).at(-1) === '⠂ Mercury', JSON.stringify(titlesOf(drawn.writes)))
await settle(1100)
check('with nothing else on the clock the title does not step by itself', titlesOf(drawn.writes).at(-1) === '⠂ Mercury', JSON.stringify(titlesOf(drawn.writes)))
clockKept = true
await drawn.set(() => props)
await settle(1200)
check('with the clock kept running it steps to the second frame', titlesOf(drawn.writes).includes('⠐ Mercury'), JSON.stringify(titlesOf(drawn.writes)))
clockKept = false
props = { ...props, animating: false, wantsPrefix: false, title: 'plain' }
await drawn.set(() => props)
check('a title that wants no prefix is written bare', titlesOf(drawn.writes).at(-1) === 'plain', JSON.stringify(titlesOf(drawn.writes)))
const before = titlesOf(drawn.writes).length
props = { ...props, enabled: false, title: 'never written' }
await drawn.set(() => props)
check('a disabled title writes nothing', titlesOf(drawn.writes).length === before, JSON.stringify(titlesOf(drawn.writes)))
drawn.unmount()

await releaseScratchHome(HOME)
console.log(`\n${failures === 0 ? 'prove-chat-title-part: ALL PASS' : `prove-chat-title-part: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
