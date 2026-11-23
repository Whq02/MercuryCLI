import React from 'react'
import { mock } from 'bun:test'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('message-renderer-edges')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const path = join(home, 'image #1 100%.png')
const urls: string[] = []
const images = await import('../../src/platform/images/imageStore.js')
mock.module('../../src/platform/images/imageStore.js', () => ({ ...images, storedImageState: () => ({ path, present: true }) }))
mock.module('../../src/screen/renderer/elements/Link.js', () => ({ default: ({ url, children }: { url: string; children: React.ReactNode }) => {
  urls.push(url)
  return <Text>{children}</Text>
} }))
const { UserImageMessage } = await import('../../src/screen/messages/UserImageMessage.js')
const { SystemTextMessage } = await import('../../src/screen/messages/SystemTextMessage.js')
const { CollapsedReadSearchContent } = await import('../../src/screen/messages/CollapsedReadSearchContent.js')
const { buildMessageLookups } = await import('../../src/engine/messages/lookups.js')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
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
  check('a memory-search-only group remains visible', memory.screen().includes('Searched memory'), 'a collapsed group with only memory searches rendered no Searched memory line; check how CollapsedReadSearchContent in src/screen/messages/CollapsedReadSearchContent.tsx counts memorySearchCount when the other counts are zero')
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
    check(`${name}: emits a file URL for its exact path`, url === pathToFileURL(path).href, `got ${url ?? 'no link'}; the Link url in src/screen/messages/UserImageMessage.tsx (image) and src/screen/messages/SystemTextMessage.tsx (saved memory) must be pathToFileURL of the stored path`)
    let decoded: string | null = null
    try { if (url !== undefined) decoded = fileURLToPath(url) } catch {}
    check(`${name}: spaces, hashes and percent signs round-trip`, decoded === path, `decoded ${decoded ?? 'nothing'}; the Link url in src/screen/messages/UserImageMessage.tsx and SystemTextMessage.tsx must be built with pathToFileURL, not by string concatenation`)
    view.unmount()
    await settle(50)
  }
} finally {
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
