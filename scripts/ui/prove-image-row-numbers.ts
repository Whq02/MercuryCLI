#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.FORCE_COLOR = '0'
const HOME = mkdtempSync(join(tmpdir(), 'image-row-numbers-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..')
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ' — ' + detail}`)
  if (!cond) failures++
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

try {
  const React = (await import('react')).default
  const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { Message } = await import('../../src/components/Message.tsx')
  const { EMPTY_LOOKUPS } = await import('../../src/utils/messages/lookups.ts')
  const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64')
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
  const paint = async (message: unknown): Promise<string> => {
    const node = React.createElement(
      AppStateProvider as never,
      { initialState: getDefaultAppState() } as never,
      React.createElement(Message as never, {
        message, tools: [], commands: [], verbose: false, addMargin: false, shouldAnimate: false, shouldShowDot: false,
        isTranscriptMode: false, isStatic: true, inProgressToolUseIDs: new Set(), progressMessagesForMessage: [], lookups: EMPTY_LOOKUPS, width: 80,
      } as never),
    )
    return stripAnsi(await renderToAnsiString(node as never, 80))
  }
  const labels = (frame: string): string[] => frame.match(/\[Image #\d+\]/g) ?? []

  section('I1 a dispatched row (no paste ids) carries its images under the numbers the composer showed')
  {
    const frame = await paint(createUserMessage({ content: [{ type: 'text', text: 'look at these [Image #12] [Image #13]' }, image, image] as never }))
    const seen = labels(frame)
    check('the two image rows read #12 and #13 (the composer\'s numbers), after the words that name them', seen.slice(-2).join(' ') === '[Image #12] [Image #13]', JSON.stringify(seen))
    check('no image row reads a per-message ordinal', !seen.includes('[Image #1]') && !seen.includes('[Image #2]'), JSON.stringify(seen))
  }

  section('I2 two rows, one image each, keep their own numbers — never #1 twice')
  {
    const first = labels(await paint(createUserMessage({ content: [{ type: 'text', text: '[Image #12]' }, image] as never })))
    const second = labels(await paint(createUserMessage({ content: [{ type: 'text', text: '[Image #13]' }, image] as never })))
    check('the first row\'s image reads #12', first.at(-1) === '[Image #12]', JSON.stringify(first))
    check('the second row\'s image reads #13', second.at(-1) === '[Image #13]', JSON.stringify(second))
  }

  section('I3 the composer\'s own ids win when the row carries them; the ordinal stands only with nothing to read')
  {
    const stamped = labels(await paint({ ...createUserMessage({ content: [{ type: 'text', text: 'no refs in the words' }, image, image] as never }), imagePasteIds: [7, 9] }))
    check('imagePasteIds number the rows', stamped.join(' ') === '[Image #7] [Image #9]', JSON.stringify(stamped))
    const bare = labels(await paint(createUserMessage({ content: [{ type: 'text', text: 'no refs in the words' }, image, image] as never })))
    check('with neither ids nor references the rows count from one within the message', bare.join(' ') === '[Image #1] [Image #2]', JSON.stringify(bare))
    const text = labels(await paint(createUserMessage({ content: 'a pasted text chip [Pasted text #4] and no image' })))
    check('a pasted-text reference numbers no image row', text.length === 0, JSON.stringify(text))
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n✅ IMAGE ROW NUMBERS — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
