#!/usr/bin/env bun
import { pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'
import { mountPart } from './chatScenarios.ts'

const HOME = pinScratchHome('chat-boot-part')

const React = await import('react')
const { Text } = await import('../../src/screen/themedRenderer.ts')
const { useChatBootLines } = await import('../../src/screen/chat/useChatBoot.tsx')
const { useNotifications } = await import('../../src/screen/notifications/notifications.tsx')
const { useAppState } = await import('../../src/screen/app-state/AppState.tsx')
const { NoSessionConnector } = await import('../../src/engine/connector/noSessionConnector.ts')
const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')

const LOST = 'the line to the runner was lost — its last words are kept'
const connector = Object.assign(new NoSessionConnector(), {
  sessionId: () => 'boot-part',
  live: () => IDLE_LIVE,
  subscribeLive: () => () => {},
  status: () => ({ interrupting: false }),
  tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null }),
  lostLine: () => ({ text: LOST, atMs: 1 }),
})

const part = await mountPart(
  () => {
    const { addNotification } = useNotifications()
    useChatBootLines({ focusedConnector: connector as never, addNotification })
    return useAppState(state => state.notifications.current)
  },
  { draw: current => React.createElement(Text, null, current?.text ?? 'no notice') },
)
await settle(120)
const drawn = part.view.screen().includes(LOST)
console.log(`  [${drawn ? 'PASS' : 'FAIL'}] the boot part mounted alone draws the lost line of its session as a notice${drawn ? '' : ` — the frame holds ${JSON.stringify(part.view.screen().trim().slice(0, 120))}: useChatBootLines in src/screen/chat/useChatBoot.tsx paints lostLine() through addNotification under the key lost-line`}`)
part.unmount()
await releaseScratchHome(HOME)
console.log(`\n${drawn ? 'prove-chat-boot-part: ALL PASS' : 'prove-chat-boot-part: 1 FAILURE(S)'}`)
process.exit(drawn ? 0 : 1)
