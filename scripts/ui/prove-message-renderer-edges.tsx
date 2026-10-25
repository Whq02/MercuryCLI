import React from 'react'
import { mock } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('message-renderer-edges')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const path = join(home, 'image #1 100%.png')
const urls: string[] = []
const images = await import('../../src/utils/imageStore.js')
mock.module('../../src/utils/imageStore.js', () => ({ ...images, storedImageState: () => ({ path, present: true }) }))
mock.module('../../src/ink/components/Link.js', () => ({ default: ({ url, children }: { url: string; children: React.ReactNode }) => {
  urls.push(url)
  return <Text>{children}</Text>
} }))
const { UserImageMessage } = await import('../../src/components/messages/UserImageMessage.js')
const { SystemTextMessage } = await import('../../src/components/messages/SystemTextMessage.js')
const { CollapsedReadSearchContent } = await import('../../src/components/messages/CollapsedReadSearchContent.js')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.js')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const mount = (element: React.ReactNode) => mountOffscreen(<AppStateProvider><ThemeProvider><Box width={120} height={24} flexDirection="column">{element}</Box></ThemeProvider></AppStateProvider>, 120, 24)
try {
  const group = {
    type: 'collapsed_read_search', uuid: 'memory-search-fixture', timestamp: new Date(0).toISOString(),
    messages: [], readCount: 0, searchCount: 0, listCount: 0,
    memoryReadCount: 0, memorySearchCount: 2, memoryWriteCount: 0,
    readFilePaths: [], searchArgs: [], relevantMemories: [],
  }
  const memory = await mount(<CollapsedReadSearchContent message={group as never} tools={[]} lookups={buildMessageLookups([], [])} inProgressToolUseIDs={new Set()} />)
  await settle(150)
  check('a memory-search-only group remains visible', memory.screen().includes('Searched memory'))
  memory.unmount()
  await settle(50)
  for (const [name, element] of [
    ['image', <UserImageMessage imageId={1} />],
    ['saved memory', <SystemTextMessage message={{ type: 'system', subtype: 'memory_saved', uuid: 'memory-fixture', timestamp: new Date(0).toISOString(), writtenPaths: [path] } as never} />],
  ] as const) {
    urls.length = 0
    const view = await mount(element)
    await settle(150)
    const url = urls.at(-1)
    check(`${name}: emits a file URL for its exact path`, url === pathToFileURL(path).href)
    let decoded: string | null = null
    try { if (url !== undefined) decoded = fileURLToPath(url) } catch {}
    check(`${name}: spaces, hashes and percent signs round-trip`, decoded === path)
    view.unmount()
    await settle(50)
  }
} finally {
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
