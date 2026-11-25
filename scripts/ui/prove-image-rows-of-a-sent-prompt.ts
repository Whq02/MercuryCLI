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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} | to fix: imageRowNumbersOf in src/engine/message-shapes/normalize.ts is the one rule for image row numbers, called by userBlockRows (split rows) and src/screen/messages/Message.tsx (whole message)`}`)
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
  type Renderable = Parameters<typeof Message>[0]['message']
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64')
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png } }
  const words = (text: string): { type: 'text'; text: string } => ({ type: 'text', text })
  const paintMessage = async (message: Renderable): Promise<string> => {
    const node = React.createElement(AppStateProvider, {
      initialState: getDefaultAppState(),
      children: React.createElement(Message, {
        message, tools: [], commands: [], verbose: false, addMargin: false, shouldAnimate: false, shouldShowDot: false,
        isTranscriptMode: false, isStatic: true, inProgressToolUseIDs: new Set<string>(), progressMessagesForMessage: [], lookups: EMPTY_LOOKUPS, width: 80,
      }),
    })
    return stripAnsi(await renderToAnsiString(node, 80))
  }
  const splitImageRows = async (prompt: Prompt): Promise<string[]> => {
    const drawn: string[] = []
    for (const row of normalizeMessages([prompt])) {
      const block = Array.isArray(row.message.content) ? row.message.content[0] : undefined
      if (block === undefined || typeof block === 'string' || block.type !== 'image') continue
      drawn.push((await paintMessage(row)).trim())
    }
    return drawn
  }
  const wholeImageRows = async (prompt: Prompt): Promise<string[]> => {
    const blocks = Array.isArray(prompt.message.content) ? prompt.message.content : []
    const count = blocks.filter(block => typeof block !== 'string' && block.type === 'image').length
    if (count === 0) return []
    const lines = (await paintMessage(prompt)).split('\n').map(line => line.trim()).filter(line => line.length > 0)
    return lines.slice(-count)
  }
  const checkBoth = async (label: string, prompt: Prompt, expected: string): Promise<void> => {
    const split = await splitImageRows(prompt)
    const whole = await wholeImageRows(prompt)
    check(`${label} — split rows`, split.join(' ') === expected, `split=${JSON.stringify(split)} expected=${expected}`)
    check(`${label} — whole matches split`, whole.join(' ') === expected && whole.join(' ') === split.join(' '), `whole=${JSON.stringify(whole)} split=${JSON.stringify(split)} expected=${expected}`)
  }

  console.log('a prompt sent to a session reaches it as its words and its images, with no paste ids; split rows and whole message must agree')
  await checkBoth(
    'two pasted images read [Image #1] and [Image #2]',
    createUserMessage({ content: [words('[Image #1] one change ; instead of it being here, have it be [Image #2] just under boot menu'), image, image] }),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'three read the three numbers their prompt names',
    createUserMessage({ content: [words('compare [Image #3] with [Image #4] and [Image #5]'), image, image, image] }),
    '[Image #3] [Image #4] [Image #5]',
  )
  await checkBoth(
    'one image pasted later in the session keeps its number',
    createUserMessage({ content: [words('[Image #6] also this'), image] }),
    '[Image #6]',
  )
  await checkBoth(
    'one pasted and one dragged read their two numbers',
    createUserMessage({ content: [words('the pasted one [Image #7] and the dragged one [Image #8]'), image, image] }),
    '[Image #7] [Image #8]',
  )
  await checkBoth(
    'the same name twice then another ([1, 1, 2], two images) reads #1 and #2',
    createUserMessage({ content: [words('check [Image #1] header and [Image #1] footer against [Image #2]'), image, image] }),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'no name at all with two images reads #1 and #2',
    createUserMessage({ content: [words('compare these two screenshots'), image, image] }),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'one name with two images reads #1 and #2',
    createUserMessage({ content: [words('look at [Image #1] and the second one'), image, image] }),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'one name ([2]) with two images fills the smallest unused number ascending (#1 and #2)',
    createUserMessage({ content: [words('look at [Image #2] and the other one'), image, image] }),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'one higher name ([5]) with two images fills the smallest unused number ascending (#1 and #5)',
    createUserMessage({ content: [words('look at [Image #5] and the other one'), image, image] }),
    '[Image #1] [Image #5]',
  )
  await checkBoth(
    'one name ([1]) with three images fills the smallest unused numbers ascending (#1, #2 and #3)',
    createUserMessage({ content: [words('look at [Image #1] and two more'), image, image, image] }),
    '[Image #1] [Image #2] [Image #3]',
  )
  await checkBoth(
    'a hand-typed earlier reference with one pasted image ([1, 2], one image) reads #2',
    createUserMessage({ content: [words('unlike [Image #1] earlier, look at [Image #2]'), image] }),
    '[Image #2]',
  )
  await checkBoth(
    'two references in descending order ([2, 1], two images) read #1 and #2',
    createUserMessage({ content: [words('replace [Image #2] with [Image #1]'), image, image] }),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'a prompt that holds the composer\'s own ids reads those',
    { ...createUserMessage({ content: [words('[Image #1] and [Image #2]'), image, image] }), imagePasteIds: [7, 9] },
    '[Image #7] [Image #9]',
  )
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n✅ the image rows of a sent prompt — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
