import { randomUUID } from 'node:crypto'
import { pinScratchHome, releaseScratchHome, mountOffscreen, settle, pinSourceRef } from '../lib/settingsPopupHarness.js'
import type { Message as MessageRow } from '../../src/types/message.js'
import type { LocalJSXCommandOnDone } from '../../src/types/command.js'

pinSourceRef()
const home = pinScratchHome('local-command-order')
const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { Message } = await import('../../src/components/Message.js')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.js')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.js')
const { createUserMessage, createAssistantMessage, createCommandInputMessage } = await import('../../src/utils/messages.js')
const { processSlashCommand, formatCommandLoadingMetadata } = await import('../../src/utils/processUserInput/processSlashCommand.js')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}

type Guts = { rawRecords: MessageRow[]; sends: Array<{ clientMessageId: string; text: string; sentAtMs: number; state: 'queued'; mode: 'prompt' }>; echoRows: Map<string, MessageRow>; reconcileSends(): boolean; paint(): void }
const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
const guts = connector as unknown as Guts
const before = createAssistantMessage({ content: 'BEFORE_COMMAND' })
guts.rawRecords = [before]
let done!: LocalJSXCommandOnDone
const uuid = randomUUID()
const pending = processSlashCommand('/order-fixture on', [], [], [], {
  options: { commands: [{ name: 'order-fixture', type: 'local-jsx', description: 'fixture', load: async () => ({ call: async (onDone: LocalJSXCommandOnDone) => { done = onDone; return null } }) }] },
} as never, () => {}, uuid)
await settle(30)
const prompt = createUserMessage({ content: 'LATER_PROMPT' })
guts.sends = [{ clientMessageId: prompt.uuid, text: 'LATER_PROMPT', sentAtMs: Date.parse(prompt.timestamp), state: 'queued', mode: 'prompt' }]
guts.echoRows.set(prompt.uuid, { ...prompt, queued: true } as MessageRow)
guts.paint()
check('the later prompt is already visible while the command awaits its answer', connector.records().at(-1)?.uuid === prompt.uuid)
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
  const frame = mounted.screen()
  const commandAt = frame.indexOf('/order-fixture')
  const answerAt = frame.indexOf('COMMAND_ANSWER')
  const promptAt = frame.indexOf('LATER_PROMPT')
  check(`${label}: the frame reads command → answer → prompt, each once`, commandAt >= 0 && commandAt < answerAt && answerAt < promptAt && frame.split('COMMAND_ANSWER').length === 2 && frame.split('LATER_PROMPT').length === 2)
  if (!(commandAt >= 0 && commandAt < answerAt && answerAt < promptAt)) console.log(frame)
}

guts.rawRecords = [before, ...result.messages]
guts.paint()
await assertFrame('queued prompt')
guts.rawRecords = [before, prompt, ...result.messages]
guts.reconcileSends()
guts.paint()
await assertFrame('prompt lands before the delayed command records')
check('the stored records are not rewritten to fix their display order', guts.rawRecords[1] === prompt)
const reload = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
const reloaded = reload as unknown as Guts
reloaded.rawRecords = [...guts.rawRecords]
reloaded.paint()
check('a reload gives the same positions as the live transcript', reload.records().map(row => row.uuid).join() === connector.records().map(row => row.uuid).join())
guts.rawRecords = [before, prompt]
connector.addDisplayRow({ ...createUserMessage({ content: formatCommandLoadingMetadata('order-fixture', 'on') }), timestamp: echo.timestamp })
connector.addDisplayRow(createCommandInputMessage('<local-command-stdout>COMMAND_ANSWER</local-command-stdout>'))
await assertFrame('screen command receipt after the prompt lands')
const overlapping = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'fixture', projectLabel: 'fixture', workspaceId: 'fixture', home })
const overlapGuts = overlapping as unknown as Guts
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
