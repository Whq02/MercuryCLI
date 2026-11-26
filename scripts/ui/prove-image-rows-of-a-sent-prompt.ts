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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} | to fix: imageRowNumbersOf in src/engine/message-shapes/normalize.ts is the one rule for image rows (called by userBlockRows and src/screen/messages/Message.tsx): draw an image row only when the prompt text does not name that image`}`)
}

try {
  const React = (await import('react')).default
  const { renderToAnsiString } = await import('../../src/screen/renderer/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
  const { Message } = await import('../../src/screen/messages/Message.tsx')
  const { copyTextOf } = await import('../../src/screen/messages/messageActions.tsx')
  const { renderableSearchText } = await import('../../src/screen/virtual-message-list/transcriptSearch.ts')
  const { EMPTY_LOOKUPS } = await import('../../src/engine/messages/lookups.ts')
  const { createAttachmentMessage } = await import('../../src/engine/attachment-shapes/attachmentMessage.ts')
  const { createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
  const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.ts')
  const { normalizeMessagesForAPI } = await import('../../src/engine/messages/apiView.ts')
  type Prompt = Extract<Parameters<typeof Message>[0]['message'], { type: 'user' }>
  type Block = Prompt['message']['content'][number]
  type Renderable = Parameters<typeof Message>[0]['message']
  const promptOf = (content: Block[], imagePasteIds?: number[]): Prompt => {
    const base = createUserMessage({ content, ...(imagePasteIds !== undefined ? { imagePasteIds } : {}) })
    return { ...base, message: { ...base.message, content } }
  }
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const nonEmptyLines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex').toString('base64')
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png } }
  const words = (text: string): { type: 'text'; text: string } => ({ type: 'text', text })
  const paintMessage = async (message: Renderable, isTranscriptMode = false): Promise<string> => {
    const node = React.createElement(AppStateProvider, {
      initialState: getDefaultAppState(),
      children: React.createElement(Message, {
        message, tools: [], commands: [], verbose: false, addMargin: false, shouldAnimate: false, shouldShowDot: false,
        isTranscriptMode, isStatic: true, inProgressToolUseIDs: new Set<string>(), progressMessagesForMessage: [], lookups: EMPTY_LOOKUPS, width: 80,
      }),
    })
    return stripAnsi(await renderToAnsiString(node, 80))
  }
  const splitImageRows = async (prompt: Prompt, isTranscriptMode = false): Promise<string[]> => {
    const drawn: string[] = []
    for (const row of normalizeMessages([prompt])) {
      const block = Array.isArray(row.message.content) ? row.message.content[0] : undefined
      if (block === undefined || typeof block === 'string' || block.type !== 'image') continue
      const painted = (await paintMessage(row, isTranscriptMode)).trim()
      if (painted.length > 0) drawn.push(painted)
    }
    return drawn
  }
  const wholeImageRows = async (prompt: Prompt, isTranscriptMode = false): Promise<string[]> => {
    const textBlocks = prompt.message.content.filter(block => block.type === 'text')
    const baseLines = textBlocks.length > 0
      ? nonEmptyLines(await paintMessage(promptOf(textBlocks), isTranscriptMode))
      : []
    const allLines = nonEmptyLines(await paintMessage(prompt, isTranscriptMode))
    return allLines.slice(baseLines.length)
  }
  const checkBoth = async (label: string, prompt: Prompt, expected: string, isTranscriptMode = false): Promise<void> => {
    const split = await splitImageRows(prompt, isTranscriptMode)
    const whole = await wholeImageRows(prompt, isTranscriptMode)
    check(`${label} — split rows`, split.join(' ') === expected, `split=${JSON.stringify(split)} expected=${JSON.stringify(expected)}`)
    check(`${label} — whole matches split`, whole.join(' ') === expected && whole.join(' ') === split.join(' '), `whole=${JSON.stringify(whole)} split=${JSON.stringify(split)} expected=${JSON.stringify(expected)}`)
  }

  console.log('an image row is drawn under a sent prompt only for images the prompt text does not name; split rows and whole message must agree')
  const ownerSingle = promptOf([words('[Image #3] look at this'), image])
  await checkBoth('one named image draws no grey row beneath the prompt', ownerSingle, '')
  await checkBoth('detailed transcript mode also draws no grey row for a named image', ownerSingle, '', true)

  const ownerTwo = promptOf([words('[Image #1] one change ; instead of it being here, have it be [Image #2] just under boot menu'), image, image])
  await checkBoth('two pasted images both named in the text draw no image row', ownerTwo, '')
  await checkBoth(
    'three named images draw no image row',
    promptOf([words('compare [Image #3] with [Image #4] and [Image #5]'), image, image, image]),
    '',
  )
  await checkBoth(
    'the same name twice then another ([1, 1, 2], two images) draws no image row',
    promptOf([words('check [Image #1] header and [Image #1] footer against [Image #2]'), image, image]),
    '',
  )
  await checkBoth(
    'a hand-typed earlier reference with one pasted image ([1, 2], one image) draws no image row',
    promptOf([words('unlike [Image #1] earlier, look at [Image #2]'), image]),
    '',
  )
  await checkBoth(
    'two references in descending order ([2, 1], two images) draw no image row',
    promptOf([words('replace [Image #2] with [Image #1]'), image, image]),
    '',
  )
  await checkBoth(
    'no name at all with two images draws both rows (#1 and #2)',
    promptOf([words('compare these two screenshots'), image, image]),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'image-only prompt with no text draws both rows (#1 and #2)',
    promptOf([image, image]),
    '[Image #1] [Image #2]',
  )
  await checkBoth(
    'mixed: one name ([1]) with two images draws only the unnamed row (#2)',
    promptOf([words('look at [Image #1] and the second one'), image, image]),
    '[Image #2]',
  )
  await checkBoth(
    'mixed: one name ([2]) with two images draws only the unnamed row (#1)',
    promptOf([words('look at [Image #2] and the other one'), image, image]),
    '[Image #1]',
  )
  await checkBoth(
    'mixed: one higher name ([5]) with two images draws only the unnamed row (#1)',
    promptOf([words('look at [Image #5] and the other one'), image, image]),
    '[Image #1]',
  )
  await checkBoth(
    'mixed: one name ([1]) with three images draws only the two unnamed rows (#2 and #3)',
    promptOf([words('look at [Image #1] and two more'), image, image, image]),
    '[Image #2] [Image #3]',
  )
  await checkBoth(
    'explicit imagePasteIds with no matching names in the words draw those ids',
    promptOf([words('[Image #1] and [Image #2]'), image, image], [7, 9]),
    '[Image #7] [Image #9]',
  )
  await checkBoth(
    'explicit imagePasteIds all named in the words draw no image row',
    promptOf([words('[Image #7] and [Image #9]'), image, image], [7, 9]),
    '',
  )
  await checkBoth(
    'explicit imagePasteIds mixed: only the unnamed id draws a row (#9)',
    promptOf([words('see [Image #7] and this'), image, image], [7, 9]),
    '[Image #9]',
  )

  const textOnlyRef = promptOf([words('what did [Image #3] show?')])
  await checkBoth('a name in the text with no image behind it draws no image row', textOnlyRef, '')
  const textOnlySplit = normalizeMessages([textOnlyRef])
  const textOnlyDrawn = (await paintMessage(textOnlySplit[0]!)).trim()
  const textOnlyWhole = (await paintMessage(textOnlyRef)).trim()
  check(
    'a name in the text with no image behind it keeps the prompt text unchanged',
    textOnlySplit.length === 1 && textOnlyDrawn.includes('what did [Image #3] show?') && textOnlyDrawn === textOnlyWhole,
    `split=${JSON.stringify(textOnlyDrawn)} whole=${JSON.stringify(textOnlyWhole)}`,
  )

  const apiRows = normalizeMessagesForAPI([ownerTwo])
  const apiBlocks = Array.isArray(apiRows[0]?.message.content) ? apiRows[0].message.content : []
  const apiImages = apiBlocks.filter(block => block.type === 'image').length
  check('what is sent to the model still carries every image block', apiImages === 2, `apiImages=${apiImages}`)

  const ownerNormalized = normalizeMessages([ownerSingle])
  check(
    'search and copy still see the prompt text naming [Image #3]',
    ownerNormalized.length === 1 &&
      renderableSearchText(ownerNormalized[0]!).includes('[image #3] look at this') &&
      copyTextOf(ownerNormalized[0]!) === '[Image #3] look at this',
    `rows=${ownerNormalized.length} search=${JSON.stringify(ownerNormalized[0] ? renderableSearchText(ownerNormalized[0]) : '')} copy=${JSON.stringify(ownerNormalized[0] ? copyTextOf(ownerNormalized[0]) : '')}`,
  )

  const queuedImageRows = async (prompt: string | Block[], imagePasteIds?: number[]): Promise<string[]> => {
    const baseText = typeof prompt === 'string'
      ? prompt
      : prompt.filter(block => block.type === 'text').map(block => block.text).join('\n')
    const baseLines = nonEmptyLines(await paintMessage(createAttachmentMessage({ type: 'queued_command', prompt: baseText, commandMode: 'prompt' })))
    const allLines = nonEmptyLines(await paintMessage(createAttachmentMessage({ type: 'queued_command', prompt, imagePasteIds, commandMode: 'prompt' })))
    return allLines.slice(baseLines.length)
  }
  const queuedNamed = await queuedImageRows([words('[Image #3] queued check'), image], [3])
  check('a queued prompt whose text names its image draws no grey row', queuedNamed.join(' ') === '', `got=${JSON.stringify(queuedNamed)}`)
  const queuedNamedString = await queuedImageRows('[Image #4] queued string check', [4])
  check('a queued string prompt whose text names its image draws no grey row', queuedNamedString.join(' ') === '', `got=${JSON.stringify(queuedNamedString)}`)
  const queuedUnnamed = await queuedImageRows([words('queued without ref'), image], [3])
  check('a queued prompt whose text does not name its image draws its row (#3)', queuedUnnamed.join(' ') === '[Image #3]', `got=${JSON.stringify(queuedUnnamed)}`)
  const queuedUnnamedString = await queuedImageRows('queued string without ref', [5])
  check('a queued string prompt whose text does not name its image draws its row (#5)', queuedUnnamedString.join(' ') === '[Image #5]', `got=${JSON.stringify(queuedUnnamedString)}`)
  const queuedMixed = await queuedImageRows([words('see [Image #3] and the other'), image, image], [3, 4])
  check('a queued mixed prompt draws only the unnamed image row (#4)', queuedMixed.join(' ') === '[Image #4]', `got=${JSON.stringify(queuedMixed)}`)
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? `\n✅ the image rows of a sent prompt — ${checks} checks` : `\n❌ ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
