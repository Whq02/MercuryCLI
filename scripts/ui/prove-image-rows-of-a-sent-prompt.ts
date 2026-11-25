#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.FORCE_COLOR = '0'
const HOME = mkdtempSync(join(tmpdir(), 'image-rows-of-a-sent-prompt-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} | to fix: the transcript draws a prompt as one row a block (userBlockRows in src/engine/message-shapes/normalize.ts), and each image row must carry the number its prompt gives it: the composer's ids when the prompt holds them, else the [Image #N] its own words name`}`)
}

try {
  const React = (await import('react')).default
  const { renderToAnsiString } = await import('../../src/screen/renderer/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { Message } = await import('../../src/screen/messages/Message.tsx')
  const { EMPTY_LOOKUPS } = await import('../../src/engine/messages/lookups.ts')
  const { createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.ts')
  type Prompt = ReturnType<typeof createUserMessage>
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64')
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png } }
  const words = (text: string): { type: 'text'; text: string } => ({ type: 'text', text })
  const imageRows = async (prompt: Prompt): Promise<string[]> => {
    const drawn: string[] = []
    for (const row of normalizeMessages([prompt])) {
      const block = Array.isArray(row.message.content) ? row.message.content[0] : undefined
      if (block === undefined || typeof block === 'string' || block.type !== 'image') continue
      const node = React.createElement(AppStateProvider, {
        initialState: getDefaultAppState(),
        children: React.createElement(Message, {
          message: row, tools: [], commands: [], verbose: false, addMargin: false, shouldAnimate: false, shouldShowDot: false,
          isTranscriptMode: false, isStatic: true, inProgressToolUseIDs: new Set<string>(), progressMessagesForMessage: [], lookups: EMPTY_LOOKUPS, width: 80,
        }),
      })
      drawn.push(stripAnsi(await renderToAnsiString(node, 80)).trim())
    }
    return drawn
  }

  console.log('a prompt sent to a session reaches it as its words and its images, with no paste ids; the transcript draws one row a block')
  const two = await imageRows(createUserMessage({ content: [words('[Image #1] one change ; instead of it being here, have it be [Image #2] just under boot menu'), image, image] }))
  check('two pasted images read [Image #1] and [Image #2]', two.join(' ') === '[Image #1] [Image #2]', JSON.stringify(two))
  const three = await imageRows(createUserMessage({ content: [words('compare [Image #3] with [Image #4] and [Image #5]'), image, image, image] }))
  check('three read the three numbers their prompt names', three.join(' ') === '[Image #3] [Image #4] [Image #5]', JSON.stringify(three))
  const later = await imageRows(createUserMessage({ content: [words('[Image #6] also this'), image] }))
  check('one image pasted later in the session keeps its number', later.join(' ') === '[Image #6]', JSON.stringify(later))
  const mixed = await imageRows(createUserMessage({ content: [words('the pasted one [Image #7] and the dragged one [Image #8]'), image, image] }))
  check('one pasted and one dragged read their two numbers', mixed.join(' ') === '[Image #7] [Image #8]', JSON.stringify(mixed))
  const stamped = await imageRows({ ...createUserMessage({ content: [words('[Image #1] and [Image #2]'), image, image] }), imagePasteIds: [7, 9] })
  check('a prompt that holds the composer\'s own ids reads those', stamped.join(' ') === '[Image #7] [Image #9]', JSON.stringify(stamped))
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n✅ the image rows of a sent prompt — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
