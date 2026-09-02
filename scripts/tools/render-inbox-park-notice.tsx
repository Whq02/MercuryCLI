// Dev render probe: the InboxParkNotice's three states at real widths.
// Run: bun run scripts/tools/render-inbox-park-notice.tsx
import * as React from 'react'
import { enableConfigs } from '../../src/utils/config.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'
import { AppStateProvider } from '../../src/state/AppState.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { InboxParkNotice } from '../../src/components/InboxParkNotice.js'

enableConfigs()
const withInbox = (messages: unknown[]) => ({ ...getDefaultAppState(), inbox: { messages } }) as never

console.log('HELD @80:')
console.log(await renderToAnsiString(
  <AppStateProvider initialState={withInbox([
    { id: 'a', from: 'lane-verifier', text: 'results', timestamp: new Date(Date.now() - 150_000).toISOString(), status: 'held' },
    { id: 'b', from: 'lane-q2', text: 'question', timestamp: new Date(Date.now() - 30_000).toISOString(), status: 'held' },
  ])}>
    <InboxParkNotice />
  </AppStateProvider>,
  80,
))
console.log('PENDING @120:')
console.log(await renderToAnsiString(
  <AppStateProvider initialState={withInbox([
    { id: 'c', from: 'lane-q4', text: 'ping', timestamp: new Date(Date.now() - 65_000).toISOString(), status: 'pending' },
  ])}>
    <InboxParkNotice />
  </AppStateProvider>,
  120,
))
const empty = await renderToAnsiString(
  <AppStateProvider initialState={withInbox([])}>
    <InboxParkNotice />
  </AppStateProvider>,
  80,
)
console.log('EMPTY:', JSON.stringify(empty))
