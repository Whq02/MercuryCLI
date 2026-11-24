import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message, UserMessage } from '../../src/engine/message-shapes/message.js'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'notice-free-prompts-'))
const originalCwd = process.cwd()
const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const project = join(scratch, 'project')
mkdirSync(project)
process.chdir(project)
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'

const React = (await import('react')).default
const { Box } = await import('../../src/screen/themedRenderer.js')
const { App } = await import('../../src/boot/App.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { renderToString } = await import('../../src/screen/renderer/staticRender.js')
const { promptRows } = await import('../../src/screen/prompts-panel/rows.js')
const { PromptsPanel } = await import('../../src/screen/prompts-panel/PromptsPanel.js')
const { RewindPicker, selectableUserMessagesFilter } = await import('../../src/screen/rewind-picker/RewindPicker.js')
const { UserTextMessage } = await import('../../src/screen/messages/UserTextMessage.js')
const { MessageRow } = await import('../../src/screen/messages/MessageRow.js')
const { deriveTranscriptRows } = await import('../../src/screen/concourse/workerTranscriptFold.js')
const { entryToRecord, recordToEntry } = await import('../../src/sessions/fabric/entryCodec.js')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/engine/connector/focusedConnector.js')
const { noSessionConnector } = await import('../../src/engine/connector/noSessionConnector.js')
const { shouldShowUserMessage, normalizeMessages } = await import('../../src/engine/messages/messages.js')
const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()

const h = React.createElement
let failures = 0
const check = (label: string, condition: boolean, detail = ''): void => {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}
let serial = 0
const user = (content: UserMessage['message']['content'], extra: Partial<UserMessage> = {}): UserMessage => ({
  type: 'user',
  uuid: `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}` as UserMessage['uuid'],
  timestamp: '2026-10-07T06:39:00.000Z',
  message: { role: 'user', content },
  ...extra,
})
const text = (value: string): { type: 'text'; text: string } => ({ type: 'text', text: value })
const monitor = '<monitor task="watch-1" name="build watch">\nbuild reached the next step\n</monitor>'
const task = '<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n<summary>background check finished</summary>\n</task-notification>'
const reminder = '<system-reminder>background context delivered</system-reminder>'
const first = user('check the workbench prompt list')
const last = user('eta on lanes? and which lanes left?')
const operator = [first, last]
const notices = [user(monitor), user([text(monitor)]), user(task), user([text(task)]), user([text(task), text(monitor)])]
const conversation = [first, ...notices, last]
const untouched = JSON.stringify(conversation)
const expected = promptRows(operator)
const snapshot: Record<string, unknown> = { operatorRows: expected }
const optionalFrames = argument('--frames')
if (optionalFrames) mkdirSync(optionalFrames, { recursive: true })
const frame = async (name: string, node: React.ReactNode): Promise<string> => {
  const output = await renderToString(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(KeybindingSetup, null, h(Box, { width: 80, flexDirection: 'column' }, node))), 80)
  check(`${name}: the source renderer produced a frame`, output.trim() !== '' && !output.includes('could not be rendered'))
  if (optionalFrames) writeFileSync(join(optionalFrames, `${name}.txt`), output + '\n')
  return output
}
const selectRecords = (records: Message[]): void => {
  const base = noSessionConnector()
  setFocusedSessionConnector(Object.assign(Object.create(base), {
    sessionId: () => 'notice-free-prompts',
    records: () => records,
    subscribeRecords: () => () => {},
    workspace: () => ({ cwd: project, projectRoot: project, label: 'proof' }),
  }))
}
const panel = async (name: string, records: Message[]): Promise<string> => {
  selectRecords(records)
  return frame(name, h(PromptsPanel, { onClose: () => {} }))
}

try {
  check('only operator prompts survive monitor and task deliveries', JSON.stringify(promptRows(conversation)) === JSON.stringify(expected), 'promptRows in src/screen/prompts-panel/rows.ts must skip user records that only carry monitor or task-notification blocks')
  check('rewind selects exactly the operator prompt identities', JSON.stringify(conversation.filter(selectableUserMessagesFilter).map(row => row.uuid)) === JSON.stringify(operator.map(row => row.uuid)), 'selectableUserMessagesFilter in src/screen/rewind-picker/RewindPicker.tsx must skip notice-only user records')
  check('notice-only rows never become empty prompt placeholders', promptRows(notices).length === 0, 'promptRows in src/screen/prompts-panel/rows.ts must return no row for a notice-only record')

  for (const [name, value] of [
    ['adjacent monitor blocks', `${monitor}\n${monitor}`],
    ['monitor plus reminder', `${monitor}\n${reminder}`],
    ['reminder-only delivery', reminder],
    ['split notice text blocks', [text(monitor), text(reminder)]],
    ['task then monitor batch', [text(task), text(monitor)]],
    ['monitor then task batch', [text(monitor), text(task)]],
    ['task then reminder batch', [text(task), text(reminder)]],
    ['task batch with trailing empty block', [text(task), text(monitor), text('')]],
  ] as const) {
    check(`${name} is not an operator prompt`, promptRows([user(value as UserMessage['message']['content'])]).length === 0, 'promptRows in src/screen/prompts-panel/rows.ts must treat this notice or reminder shape as not an operator prompt')
  }
  const saturn = user('scheduled check', { origin: { kind: 'saturn', fire: 'cron', firedAt: first.timestamp } })
  const advisor = user('advisor check', { origin: { kind: 'advisor', model: 'fixture-model', minutes: 5, at: first.timestamp } })
  check('scheduled and advisor notices use existing origin recognition', promptRows([saturn, advisor]).length === 0, 'promptRows in src/screen/prompts-panel/rows.ts must skip records whose origin is saturn or advisor')

  const retained = [
    user('   '),
    user('<bash-input>git status --short</bash-input>'),
    user('<command-name>/help</command-name><command-args>workbench</command-args>'),
    user(`explain this event: ${monitor}`),
    user(`${monitor}\nthese are my own words`),
    user([text(monitor), text('my own words in a later block')]),
    user([text('my own words in an earlier block'), text(monitor)]),
    user([text(`explain this task: ${task}`), text(monitor)]),
    user([text(task), text('operator followup between notices'), text(monitor)]),
    user([text(task), text(monitor), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
    user('<monitor task="watch-1" name="build watch">not closed'),
    user('operator with explicit human origin', { origin: { kind: 'human' } }),
    user([text(monitor), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
    user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }]),
  ]
  snapshot.retainedRows = promptRows(retained)
  check('operator text, quoted tags, incomplete tags, blank and image prompts remain selectable', promptRows(retained).length === retained.length, `${promptRows(retained).length} of ${retained.length} rows kept; promptRows in src/screen/prompts-panel/rows.ts must keep operator text, quoted or unclosed tags, blank and image prompts`)
  check('filtering is read-only over original records', JSON.stringify(conversation) === untouched, 'promptRows or selectableUserMessagesFilter changed the records it was given; they must filter without mutating')

  let ordinal = 0
  const encoded = conversation.map(row => entryToRecord(row as unknown as Record<string, unknown>, {
    sessionId: 'notice-free-prompts' as never,
    nextOrdinal: () => ++ordinal as never,
    observedAt: first.timestamp,
    source: { channel: 'interactive' },
  }))
  const replayed = (JSON.parse(JSON.stringify(encoded)) as typeof encoded).map(recordToEntry) as unknown as Message[]
  check('unmarked transcript records replay with the same operator-only rows', JSON.stringify(promptRows(replayed)) === JSON.stringify(expected), 'entryToRecord and recordToEntry in src/sessions/fabric/entryCodec.ts must keep the content promptRows reads')
  check('replay does not add metadata to the historical record', replayed.every(row => row.type !== 'user' || row.isMeta === undefined), 'recordToEntry in src/sessions/fabric/entryCodec.ts must not add isMeta to a replayed record')

  const purePanel = await panel('operator-panel-80', operator)
  const mixedPanel = await panel('notice-panel-80', conversation)
  snapshot.operatorPanel = purePanel
  check('80-column workbench notice conversation paints the operator-only frame byte for byte', mixedPanel === purePanel, 'PromptsPanel (src/screen/prompts-panel/PromptsPanel.tsx) must paint only operator prompts from the focused session records')
  check('80-column workbench has both operator prompts and no placeholder', mixedPanel.includes(first.message.content as string) && mixedPanel.includes(last.message.content as string) && !mixedPanel.includes('(no prompt text)'), 'PromptsPanel must show both operator prompts and no placeholder row for a notice')
  selectRecords(conversation)
  const rewind = await frame('rewind-80', h(RewindPicker, { messages: conversation, onPreRestore: () => {}, onRestore: async () => ({ outcome: 'refused', refusal: 'restore-failed' } as never), onSummarize: () => {}, onClose: () => {} }))
  check('rewind paints both operator prompts without notice placeholders', rewind.includes(first.message.content as string) && rewind.includes(last.message.content as string) && !rewind.includes('(no prompt text)'), 'MessageSelector in src/screen/rewind-picker/RewindPicker.tsx must list both operator prompts and no placeholder for a notice')

  const normal = normalizeMessages(conversation)
  check('chat visibility keeps every original notification', normal.every(row => shouldShowUserMessage(row, false)), 'shouldShowUserMessage in src/engine/message-shapes/systemMessages.ts must keep every notification visible in chat')
  snapshot.chat = await frame('chat-notices-80', h(Box, { flexDirection: 'column' }, ...[monitor, task].map((body, index) => h(UserTextMessage, { key: index, addMargin: false, verbose: false, param: text(body) }))))
  const derived = deriveTranscriptRows(conversation, [])
  snapshot.mirrorRecords = derived.collapsed
  snapshot.mirror = await frame('mirror-notices-80', h(Box, { flexDirection: 'column' }, ...derived.collapsed.map((row, index) => h(MessageRow, {
    key: row.uuid,
    message: row,
    isUserContinuation: row.type === 'user' && derived.collapsed[index - 1]?.type === 'user',
    hasContentAfter: false,
    tools: [], commands: [], verbose: false,
    inProgressToolUseIDs: derived.inProgress, streamingToolUseIDs: new Set<string>(),
    screen: 'prompt', canAnimate: false, lastThinkingBlockId: null, latestBashOutputUUID: null,
    columns: 80, isLoading: false, lookups: derived.lookups,
  }))))
  check('chat and mirror keep the monitor delivery behind the same counted fold', String(snapshot.chat).includes('[Monitor]') && String(snapshot.mirror).includes('[Monitor]') && /· \d+ lines? ›/.test(String(snapshot.chat)) && /· \d+ lines? ›/.test(String(snapshot.mirror)) && !String(snapshot.chat).includes('build reached the next step') && !String(snapshot.mirror).includes('build reached the next step'), 'UserTextMessage and MessageRow must fold a monitor delivery to a [Monitor] line with a line count in both chat and mirror')
  const expandedChat = await frame('chat-notices-open-80', h(UserTextMessage, { addMargin: false, verbose: true, param: text(monitor) }))
  const expandedMirror = await frame('mirror-notices-open-80', h(Box, { flexDirection: 'column' }, ...derived.collapsed.map((row, index) => h(MessageRow, {
    key: row.uuid, message: row,
    isUserContinuation: row.type === 'user' && derived.collapsed[index - 1]?.type === 'user',
    hasContentAfter: false, tools: [], commands: [], verbose: true,
    inProgressToolUseIDs: derived.inProgress, streamingToolUseIDs: new Set<string>(),
    screen: 'prompt', canAnimate: false, lastThinkingBlockId: null, latestBashOutputUUID: null,
    columns: 80, isLoading: false, lookups: derived.lookups,
  }))))
  check('opening chat and mirror preserves the whole monitor delivery text', expandedChat.includes('build reached the next step') && expandedMirror.includes('build reached the next step'), 'UserTextMessage and MessageRow must show the whole monitor text when verbose is true')

  const baseline = argument('--compare')
  if (baseline) {
    const before = JSON.parse(readFileSync(baseline, 'utf8')) as typeof snapshot
    for (const key of Object.keys(snapshot)) check(`${key} is byte-identical to the base`, JSON.stringify(snapshot[key]) === JSON.stringify(before[key]))
  }
  const output = argument('--snapshot')
  if (output) writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n')
} finally {
  releaseFocusedSessionConnector()
  process.chdir(originalCwd)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`notice-free-prompts: ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
