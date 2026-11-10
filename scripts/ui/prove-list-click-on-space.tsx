import React from 'react'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('list-click-on-space')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/ink.js')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.js')
const { VirtualMessageList } = await import('../../src/components/VirtualMessageList.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { createUserMessage } = await import('../../src/utils/messages/factories.js')
type Scroll = import('../../src/ink/components/ScrollBox.js').ScrollBoxHandle
type Row = ReturnType<typeof createUserMessage>

const COLUMNS = 60
const VIEWPORT = 14
const ROWS = 8
const GROUP_AT = 3
const HINTED_AT = 5
const SHUT = 'Ran 4 bash commands'
const OPEN = 'Expanded group (4 calls)'
const HINTED = 'Running 2 bash commands'
const HINT = '   └ npm test'
const PLAIN = (at: number): string => `plain row ${at}`

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

type Stage = { view: Mounted; press: (column: number, row: number) => void; heard: () => number[]; open: () => boolean }

async function stage(): Promise<Stage> {
  const scroll = React.createRef<Scroll>()
  const rows: Row[] = Array.from({ length: ROWS }, (_, at) => createUserMessage({ content: `row ${at}` }))
  const indexOf = new Map(rows.map((row, at) => [row.uuid, at]))
  const listeners = new Set<() => void>()
  const heard: number[] = []
  let open = false
  const toggle = (row: Row): void => {
    const at = indexOf.get(row.uuid)!
    heard.push(at)
    if (at !== GROUP_AT) return
    open = !open
    for (const listener of listeners) listener()
  }
  const clickable = (row: Row): boolean => indexOf.get(row.uuid) === GROUP_AT || indexOf.get(row.uuid) === HINTED_AT
  function Pane(): React.ReactNode {
    const isOpen = React.useSyncExternalStore(
      listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => open,
    )
    const renderItem = React.useCallback(
      (row: Row): React.ReactNode => {
        const at = indexOf.get(row.uuid)!
        if (at === GROUP_AT) return <Text>{isOpen ? OPEN : SHUT}</Text>
        if (at === HINTED_AT)
          return (
            <Box flexDirection="column">
              <Text>{HINTED}</Text>
              <Text>{HINT}</Text>
            </Box>
          )
        return <Text>{PLAIN(at)}</Text>
      },
      [isOpen],
    )
    return (
      <Box width={COLUMNS} height={VIEWPORT + 1} flexDirection="column">
        <ScrollBox ref={scroll} height={VIEWPORT} flexDirection="column" stickyScroll>
          <Box flexDirection="column" width="100%">
            <VirtualMessageList
              messages={rows as never}
              scrollRef={scroll}
              columns={COLUMNS}
              itemKey={row => row.uuid}
              selectedIndex={undefined}
              renderItem={renderItem as never}
              onItemClick={toggle as never}
              isItemClickable={clickable as never}
            />
          </Box>
        </ScrollBox>
        <Text>FLOOR</Text>
      </Box>
    )
  }
  const before = new Set(instances.keys())
  const view = await mountOffscreen(
    <AppStateProvider>
      <ThemeProvider>
        <Pane />
      </ThemeProvider>
    </AppStateProvider>,
    COLUMNS,
    VIEWPORT + 1,
  )
  const ink = instances.get([...instances.keys()].find(key => !before.has(key))!)!
  return { view, press: (column, row) => void ink.dispatchClick(column, row), heard: () => [...heard], open: () => open }
}

async function click(live: Stage, words: string, column: number): Promise<{ heard: number[]; row: number }> {
  const row = live.view.lines().findIndex(line => line.startsWith(words))
  const before = live.heard().length
  if (row >= 0) live.press(column, row)
  await settle(80)
  return { heard: live.heard().slice(before), row }
}

const spaceAfter = (line: string, word: string): number => line.indexOf(word) + word.length
const said = (hit: { heard: number[]; row: number }): string => `pane row ${hit.row}, the list heard ${hit.heard.length === 0 ? 'nothing' : `row ${hit.heard.join(',')}`}`

const live = await stage()
try {
  await waitFor(() => live.view.lines().some(line => line.startsWith(SHUT)), 3000)
  await settle(150)
  const frame = live.view.lines()
  check(
    'the scene paints the two clickable rows and a plain row with no ground under them',
    frame.some(line => line === SHUT) && frame.some(line => line === HINTED) && frame.some(line => line === HINT.trimEnd()) && frame.some(line => line === PLAIN(1)) && live.view.styleAt(spaceAfter(SHUT, 'Ran'), frame.indexOf(SHUT))?.bg == null,
    frame.slice(0, ROWS + 2).join(' | '),
  )

  const onLetter = await click(live, SHUT, 1)
  check('a click on a letter of a clickable row toggles it', onLetter.heard.join() === String(GROUP_AT) && live.open(), said(onLetter))
  await waitFor(() => live.view.lines().some(line => line.startsWith(OPEN)), 2000)

  const betweenWords = await click(live, OPEN, spaceAfter(OPEN, 'Expanded'))
  check('a click on the space between two words of the row toggles it', betweenWords.heard.join() === String(GROUP_AT) && !live.open(), said(betweenWords))
  await waitFor(() => live.view.lines().some(line => line.startsWith(SHUT)), 2000)

  const everySpace = [spaceAfter(SHUT, 'Ran'), spaceAfter(SHUT, '4'), spaceAfter(SHUT, 'bash')]
  const hits: string[] = []
  for (const column of everySpace) {
    hits.push((await click(live, SHUT, column)).heard.join())
    if (live.open()) {
      await waitFor(() => live.view.lines().some(line => line.startsWith(OPEN)), 2000)
      await click(live, OPEN, 1)
    }
    await waitFor(() => live.view.lines().some(line => line.startsWith(SHUT)), 2000)
  }
  check('each of the three spaces of the collapsed line is the line', hits.every(hit => hit === String(GROUP_AT)), `columns ${everySpace.join(',')} heard [${hits.join('] [')}]`)

  const pastTheEnd = await click(live, SHUT, SHUT.length + 3)
  const farRight = await click(live, SHUT, COLUMNS - 2)
  check('a click past the end of the line, inside the row, toggles nothing', pastTheEnd.heard.length === 0 && farRight.heard.length === 0 && !live.open(), `${said(pastTheEnd)}; ${said(farRight)}`)

  const indentation = await click(live, HINT, 1)
  const hintWords = await click(live, HINT, spaceAfter(HINT, 'npm'))
  check('a click on the indentation before a line toggles nothing', indentation.heard.length === 0, said(indentation))
  check('a click on the space between the words of an indented line reaches its row', hintWords.heard.join() === String(HINTED_AT), said(hintWords))

  const plain = await click(live, PLAIN(1), spaceAfter(PLAIN(1), 'plain'))
  check('a click on a row that is not clickable is heard by none', plain.heard.length === 0, said(plain))
} finally {
  live.view.unmount()
  await releaseScratchHome(home)
}

console.log(`\n${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
