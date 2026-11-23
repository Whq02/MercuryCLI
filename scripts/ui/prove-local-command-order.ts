import { randomUUID } from 'node:crypto'
import { pinScratchHome, releaseScratchHome, mountOffscreen, settle, pinSourceRef } from '../lib/settingsPopupHarness.js'
import type { Message as MessageRow } from '../../src/engine/message-shapes/message.js'
import type { LocalJSXCommandOnDone } from '../../src/commands/catalogue/command.js'

pinSourceRef()
const home = pinScratchHome('local-command-order')
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { Message } = await import('../../src/screen/messages/Message.js')
const { normalizeMessages } = await import('../../src/engine/message-shapes/normalize.js')
const { buildMessageLookups } = await import('../../src/engine/messages/lookups.js')
const { createUserMessage, createAssistantMessage, createCommandInputMessage } = await import('../../src/engine/messages/messages.js')
const { processSlashCommand, formatCommandLoadingMetadata } = await import('../../src/engine/user-input/processSlashCommand.js')
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()

let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ' | to fix: display order of a local command echo and its answer is placed by placeLocalCommandRows in src/engine/connector/localCommandRows.ts (called from paint in src/engine/connector/daemon/transcript.ts); the echo keeping its uuid and timestamp comes from processSlashCommand in src/engine/user-input/processSlashCommand.ts'}`)
}

type Guts = { rawRecords: MessageRow[]; paint(): void }
const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
const guts = (connector as unknown as { transcriptPart: Guts }).transcriptPart
const before = createAssistantMessage({ content: 'BEFORE_COMMAND' })
guts.rawRecords = [before]
let done!: LocalJSXCommandOnDone
const uuid = randomUUID()
const pending = processSlashCommand('/order-fixture on', [], [], [], {
  options: { commands: [{ name: 'order-fixture', type: 'local-jsx', description: 'fixture', load: async () => ({ call: async (onDone: LocalJSXCommandOnDone) => { done = onDone; return null } }) }] },
} as never, () => {}, uuid)
await settle(30)
const prompt = createUserMessage({ content: 'LATER_PROMPT' })
await settle(30)
done('COMMAND_ANSWER')
const result = await pending
let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
const echo = result.messages.find(row => row.type === 'user' && typeof row.message.content === 'string' && row.message.content.startsWith('<command-message>'))!
check('the command keeps its submission identity and creation time', echo?.uuid === uuid && Date.parse(echo.timestamp) < Date.parse(prompt.timestamp))

async function assertFrame(label: string): Promise<void> {
  const rows = [...connector.records()]
  const normalized = normalizeMessages(rows).filter(row => row.type !== 'progress')
  const lookups = buildMessageLookups(normalized, rows)
  const body = React.createElement(Box, { flexDirection: 'column' }, ...normalized.map(message => React.createElement(Message, {
    key: message.uuid, message, messages: normalized, tools: [], commands: [], verbose: true, addMargin: false, shouldAnimate: false, shouldShowDot: false, isTranscriptMode: true, isStatic: true, inProgressToolUseIDs: new Set<string>(), progressMessagesForMessage: [], lookups, width: 120,
  })))
  const element = React.createElement(AppStateProvider, { children: body })
  if (mounted) mounted.resize(element, 120, 44)
  else mounted = await mountOffscreen(element, 120, 44)
  await settle(70)
  for (let waited = 70; mounted.screen().trim() === '' && waited < 5_000; waited += 25) await settle(25)
  const frame = mounted.screen()
  const commandAt = frame.indexOf('/order-fixture')
  const answerAt = frame.indexOf('COMMAND_ANSWER')
  const promptAt = frame.indexOf('LATER_PROMPT')
  check(`${label}: the frame reads command → answer → prompt, each once`, commandAt >= 0 && commandAt < answerAt && answerAt < promptAt && frame.split('COMMAND_ANSWER').length === 2 && frame.split('LATER_PROMPT').length === 2)
  if (!(commandAt >= 0 && commandAt < answerAt && answerAt < promptAt)) console.log(frame)
}

guts.rawRecords = [before, prompt, ...result.messages]
guts.paint()
await assertFrame('prompt lands before the delayed command records')
check('the stored records are not rewritten to fix their display order', guts.rawRecords[1] === prompt)
const reload = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
const reloaded = (reload as unknown as { transcriptPart: Guts }).transcriptPart
reloaded.rawRecords = [...guts.rawRecords]
reloaded.paint()
check('a reload gives the same positions as the live transcript', reload.records().map(row => row.uuid).join() === connector.records().map(row => row.uuid).join())
guts.rawRecords = [before, prompt]
connector.addDisplayRow({ ...createUserMessage({ content: formatCommandLoadingMetadata('order-fixture', 'on') }), timestamp: echo.timestamp })
connector.addDisplayRow(createCommandInputMessage('<local-command-stdout>COMMAND_ANSWER</local-command-stdout>'))
await assertFrame('screen command receipt after the prompt lands')
const overlapping = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
const overlapGuts = (overlapping as unknown as { transcriptPart: Guts }).transcriptPart
const stamp = (second: number): string => new Date(Date.UTC(2026, 0, 1, 10, 0, second)).toISOString()
const firstEcho = { ...createUserMessage({ content: formatCommandLoadingMetadata('first', '') }), timestamp: stamp(1) }
const firstAnswer = { ...createCommandInputMessage('<local-command-stdout>FIRST_ANSWER</local-command-stdout>'), timestamp: stamp(4) }
const secondEcho = { ...createUserMessage({ content: formatCommandLoadingMetadata('second', '') }), timestamp: stamp(2) }
const secondAnswer = { ...createCommandInputMessage('<local-command-stdout>SECOND_ANSWER</local-command-stdout>'), timestamp: stamp(5) }
const laterPrompt = { ...prompt, timestamp: stamp(3) }
overlapGuts.rawRecords = [laterPrompt, firstEcho, firstAnswer, secondEcho, secondAnswer]
overlapGuts.paint()
check('overlapping commands move as whole groups, never splitting an earlier echo from its answer', overlapping.records().map(row => row.uuid).join() === [firstEcho, firstAnswer, secondEcho, secondAnswer, laterPrompt].map(row => row.uuid).join())
mounted?.unmount()
await releaseScratchHome(home)
console.log(`local-command-order: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
