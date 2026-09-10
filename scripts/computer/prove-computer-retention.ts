#!/usr/bin/env bun
import { check, finish, section, sourceText } from './computerProofKit.ts'
import { toolResultTurn, toolUseTurn } from './computerToolKit.ts'

const retention = await import('../../src/services/desktop/screenshotRetention.ts')
const session = await import('../../src/services/desktop/desktopSession.ts')
const { stripImagesFromMessages } = await import('../../src/services/compact/compact.ts')
const { processOwnerForLane } = await import('../../src/services/run/resolveOwner.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Message = import('../../src/types/message.ts').Message

const PNG_B64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')
const owner = processOwnerForLane(null)
const pathOf = (i: number): string => `/shots/desktop-shots/${1000 + i}-shot.png`

function screenshotResult(id: string, path: string): unknown {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: [
      { type: 'text', text: `screenshot: ${path} — display 1 (1600×1000 px of 1440×900 pt) · cursor (10, 10) · frontmost TextEdit` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    ],
  }
}

function conversation(count: number): { messages: Message[]; ids: string[] } {
  const messages: Message[] = [createUserMessage({ content: 'drive the editor' }) as Message]
  const ids: string[] = []
  for (let i = 1; i <= count; i++) {
    const id = `toolu_shot_${i}`
    ids.push(id)
    session.noteScreenshot(owner, id, pathOf(i))
    messages.push(toolUseTurn(id, 'Computer', { action: 'screenshot' }))
    messages.push(toolResultTurn(screenshotResult(id, pathOf(i))))
  }
  return { messages, ids }
}

const blocksOf = (message: Message): Array<Record<string, unknown>> => {
  const content = (message as { message: { content: unknown } }).message.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}
const resultBlocks = (message: Message): Array<Record<string, unknown>> => {
  const block = blocksOf(message).find(b => b.type === 'tool_result')
  const content = block?.content
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : []
}
const hasImage = (message: Message): boolean => resultBlocks(message).some(b => b.type === 'image')

section('§1 the transcript projection stubs a Computer screenshot and leaves everything else by reference')
{
  session.noteScreenshot(owner, 'toolu_project', pathOf(1))
  const mine = toolResultTurn(screenshotResult('toolu_project', pathOf(1)))
  const projected = retention.projectForTranscript(mine)
  const blocks = resultBlocks(projected)
  check('the image block became the stub text naming the file', blocks.length === 2 && blocks[0]?.type === 'text' && blocks[1]?.type === 'text' && String(blocks[1]?.text) === retention.screenshotStubText(pathOf(1)), JSON.stringify(blocks))
  check('the stub says the image is not kept and names the path', retention.screenshotStubText(pathOf(1)).includes('not kept') && retention.screenshotStubText(pathOf(1)).includes(pathOf(1)))
  check('the original message is untouched (a new message was built)', hasImage(mine) && projected !== mine)
  const browser = toolResultTurn(screenshotResult('toolu_browser_shot', '/shots/browser-shots/1.png'))
  check('an unregistered image result (the Browser\'s) passes by reference', retention.projectForTranscript(browser) === browser)
  const assistant = toolUseTurn('toolu_x', 'Computer', { action: 'screenshot' })
  const plain = createUserMessage({ content: 'hello' }) as Message
  check('an assistant message and a plain user message pass by reference', retention.projectForTranscript(assistant) === assistant && retention.projectForTranscript(plain) === plain)
}

section('§2 the wire window keeps the newest three once thirteen are live')
{
  check('the constants: keep 3, high water 12', retention.SCREENSHOT_KEEP_RECENT === 3 && retention.SCREENSHOT_WIRE_HIGH_WATER === 12)
  const { messages, ids } = conversation(13)
  const retired = retention.retireOlderScreenshots(messages, retention.SCREENSHOT_KEEP_RECENT, retention.SCREENSHOT_WIRE_HIGH_WATER)
  const kept = retired.messages.filter(hasImage).length
  check('three images remain', kept === 3, `${kept} images`)
  const oldest = retired.messages[2]!
  const oldestBlocks = resultBlocks(oldest)
  check('the oldest screenshot\'s image became the earlier-screenshot text and its text line stayed', oldestBlocks.length === 2 && oldestBlocks[0]?.type === 'text' && String(oldestBlocks[0]?.text).startsWith('screenshot: ') && oldestBlocks[1]?.type === 'text' && String(oldestBlocks[1]?.text) === retention.earlierScreenshotText(pathOf(1)), JSON.stringify(oldestBlocks))
  const newest = retired.messages[retired.messages.length - 1]!
  check('the newest keeps its image', hasImage(newest))
  check('firstEdited is the oldest screenshot\'s message index', retired.firstEdited === 2, String(retired.firstEdited))
  check('untouched messages pass by reference', retired.messages[0] === messages[0] && retired.messages[1] === messages[1] && retired.messages[retired.messages.length - 1] === messages[messages.length - 1])
  check('ten screenshots were retired: the ids of the newest three are the last three', ids.slice(-3).every(id => retired.messages.some(m => resultBlocks(m).some(b => b.type === 'image') && blocksOf(m).some(b => b.tool_use_id === id))))
  const { messages: twelve } = conversation(12)
  const untouched = retention.retireOlderScreenshots(twelve, retention.SCREENSHOT_KEEP_RECENT, retention.SCREENSHOT_WIRE_HIGH_WATER)
  check('twelve or fewer: the same array by reference and firstEdited -1', untouched.messages === twelve && untouched.firstEdited === -1)
}

section('§3 the wire call sites (structural)')
{
  const stream = sourceText('src/services/providers/anthropic/streamCore.ts')
  const media = stream.indexOf('stripExcessMediaItems(')
  const retire = stream.indexOf('retireOlderScreenshots(')
  const thinking = stream.indexOf('stripThinkingFromIndex(', retire)
  check('streamCore.ts retires older screenshots beside the media strip and then strips thinking from the first edited index', media >= 0 && retire > media && thinking > retire, `${media} ${retire} ${thinking}`)
  const openai = sourceText('src/services/providers/openai/openaiCallModel.ts')
  const retireOpenai = openai.indexOf('retireOlderScreenshots(')
  const bridge = openai.indexOf('toBridgeMessages(', retireOpenai)
  check('openaiCallModel.ts retires older screenshots before the bridge', retireOpenai >= 0 && bridge > retireOpenai, `${retireOpenai} ${bridge}`)
  const compat = sourceText('src/services/providers/openaicompat/compatChatCallModel.ts')
  const retireCompat = compat.indexOf('retireOlderScreenshots(')
  check('compatChatCallModel.ts retires older screenshots before the codec', retireCompat >= 0 && compat.indexOf('mapMessagesToZai(', retireCompat) > retireCompat)
  const zai = sourceText('src/services/providers/zai/zaiCallModel.ts')
  check('the direct GLM runtime retires older screenshots too', zai.includes('retireOlderScreenshots('))
  const chain = sourceText('src/utils/sessionStorage/chain.ts')
  check('the session file chain projects every record it cleans for the file', chain.includes('.map(projectForTranscript)'))
}

section('§4 the screenshot a coordinate act refers to must still be visible')
{
  const { messages } = conversation(13)
  check('visible before anything happens', retention.screenshotVisibleInContext(messages, 'toolu_shot_13') === true && retention.screenshotVisibleInContext(messages, 'toolu_shot_1') === true)
  check('an unknown id is not visible', retention.screenshotVisibleInContext(messages, 'toolu_never') === false)
  const stripped = stripImagesFromMessages(messages)
  check('after the compaction strip nothing is visible', retention.screenshotVisibleInContext(stripped, 'toolu_shot_13') === false)
  const retired = retention.retireOlderScreenshots(messages, retention.SCREENSHOT_KEEP_RECENT, retention.SCREENSHOT_WIRE_HIGH_WATER)
  check('after the window the retired one is gone and the newest stays visible', retention.screenshotVisibleInContext(retired.messages, 'toolu_shot_1') === false && retention.screenshotVisibleInContext(retired.messages, 'toolu_shot_13') === true)
}

section('§5 the registry keys by tool-use id across owners')
{
  const other = processOwnerForLane('agent-retention')
  session.noteScreenshot(owner, 'toolu_owner_a', '/shots/a.png')
  session.noteScreenshot(other, 'toolu_owner_b', '/shots/b.png')
  check('each id answers its own path from any owner', session.screenshotPathForToolUse('toolu_owner_a') === '/shots/a.png' && session.screenshotPathForToolUse('toolu_owner_b') === '/shots/b.png')
  check('an unknown id answers null', session.screenshotPathForToolUse('toolu_unknown') === null)
}

finish('prove-computer-retention')
