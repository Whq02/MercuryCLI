import React from 'react'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('transcript-search-steps')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/ink.js')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.js')
const { VirtualMessageList } = await import('../../src/components/VirtualMessageList.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { createUserMessage } = await import('../../src/utils/messages/factories.js')
type Jump = import('../../src/components/VirtualMessageList.js').JumpHandle
type Scroll = import('../../src/ink/components/ScrollBox.js').ScrollBoxHandle
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const scroll = React.createRef<Scroll>()
const jump = React.createRef<Jump>()
let selected = -1
const rows = [createUserMessage({ content: 'needle needle needle' })]
const view = await mountOffscreen(<AppStateProvider><ThemeProvider><Box width={80} height={24}>
  <ScrollBox ref={scroll} height={20} flexDirection="column">
    <VirtualMessageList messages={rows} scrollRef={scroll} columns={80} itemKey={row => row.uuid}
      selectedIndex={undefined} jumpRef={jump} renderItem={() => <Text>needle needle needle</Text>}
      extractSearchText={() => 'needle needle needle'}
      scanElement={() => [0, 7, 14].map(col => ({ row: 0, col, length: 6 }))}
      setPositions={state => { if (state !== null) selected = state.currentIdx }} />
  </ScrollBox>
</Box></ThemeProvider></AppStateProvider>, 80, 24)
try {
  check('the row paints', await waitFor(() => view.screen().includes('needle needle needle'), 3000))
  jump.current!.setSearchQuery('needle')
  check('the initial preview selects the last occurrence', await waitFor(() => selected === 2, 3000))
  jump.current!.prevMatch()
  await settle(100)
  check('previous moves to the middle occurrence', selected === 1)
  jump.current!.prevMatch()
  await settle(100)
  check('previous moves to the first occurrence', selected === 0)
  jump.current!.nextMatch()
  await settle(100)
  check('next returns to the middle occurrence', selected === 1)
} finally {
  view.unmount()
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
