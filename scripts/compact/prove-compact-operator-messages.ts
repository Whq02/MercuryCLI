#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE', 'MERCURY_HOME', 'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_THINKING_BINDING', 'MERCURY_SM_COMPACT',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-operator-messages-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'compact-operator-messages-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
const SELECTION_MODULE = 'src/engine/compaction-window/operatorMessages.ts'
const KIND = 'compact_operator_messages'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — compact operator-messages prover exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const { startOverflowFixture, OVERFLOW_WIRE_SHAPES } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { createUserMessage, createAssistantMessage } = await import('../../src/engine/messages/messages.ts')
const { createFoldBoundaryMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { createAttachmentMessage } = await import('../../src/engine/attachments/turnAttachments.ts')
const { normalizeAttachmentForAPI } = await import('../../src/engine/messages/attachmentText.ts')
const { normalizeMessagesForAPI } = await import('../../src/engine/messages/apiView.ts')
const { NULL_RENDERING_ATTACHMENT_TYPES, isNullRenderingAttachment } = await import('../../src/screen/messages/nullRenderingAttachments.ts')
const { BODY_SHAPE_KINDS } = await import('../../src/sessions/fabric/validate.ts')
const { estimateContextTokens } = await import('../../src/engine/compaction/pruneToolResults.ts')
const compactMod = await import('../../src/engine/compaction/foldConversation.ts')
const chain = await import('../../src/sessions/transcripts/chain.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { turnDoor } = await import('../../src/engine/turnDoor.ts')
const { productionDeps } = await import('../../src/engine/turn-entry/turnLoopDeps.ts')

type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string }
type Entry = { ordinal: number; text: string; truncated?: boolean }
type Block = { type: string; messages: Entry[]; omitted: number }
type Selection = {
  selectOperatorMessages: (messages: unknown[], opts?: { keptUuids?: ReadonlySet<string>; tokenBudget?: number }) => Block | null
  collectOperatorTexts: (messages: unknown[], keptUuids?: ReadonlySet<string>) => string[]
  priorOperatorMessages: (messages: unknown[]) => number
  operatorMessagesBlockText: (attachment: Block) => string
  OPERATOR_MESSAGES_TOKEN_BUDGET: number
  OPERATOR_MESSAGES_ATTACHMENT_TYPE: string
}
let selection: Selection | null = null
if (existsSync(join(ROOT, SELECTION_MODULE))) selection = (await import(join(ROOT, SELECTION_MODULE))) as Selection

let seq = 0
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function assistant(text: string): AnyMsg {
  seq++
  return {
    type: 'assistant',
    uuid: uuidOf(seq),
    timestamp: new Date().toISOString(),
    requestId: `req_${seq}`,
    message: {
      id: `msg_${seq}`,
      type: 'message',
      role: 'assistant',
      model: 'fixture',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 400 + seq, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }
}
const textOf = (m: unknown): string => {
  const msg = m as AnyMsg
  const c = (msg.message as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  if (typeof msg.content === 'string') return msg.content
  return ''
}
const rowText = (m: unknown): string => {
  const msg = m as AnyMsg
  if (msg.type === 'attachment') return j(msg.attachment)
  return textOf(m)
}
const wireTextOf = (row: unknown): string => {
  const c = (row as { content?: unknown } | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return (c as AnyMsg[]).filter(b => b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  return ''
}
const blockOf = (m: unknown): Block | null => {
  const msg = m as AnyMsg | undefined
  if (msg === undefined || msg === null || msg.type !== 'attachment') return null
  const att = msg.attachment as Block | undefined
  return att !== undefined && att.type === KIND ? att : null
}
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }

const PROMPTS = [
  'p1: rename the helper in src/lib/names.ts to formatLabel',
  'p2: add a unit test for formatLabel covering the empty string',
  'p3: run the test suite and report the failing cases',
  'p4: the second failure is a fixture typo, fix the fixture not the code',
  'p5: now wire formatLabel into the settings screen',
  `p6: ${'refactor the settings screen carefully, keep the layout, keep the copy, keep the keybindings, and touch nothing else. '.repeat(8)}`,
  'p7: write the changelog entry for the rename',
  'p8: stop and summarise what is left',
]
const REPLIES = PROMPTS.map((_, index) => `reply ${index + 1}: done with the ${index + 1}th ask and its checks pass`)
const WAKE_TEXT = '[self-paced wake — why you woke: the timer]\ncheck the build once more'
const ECHO_TEXT = '<command-message>init</command-message>\n<command-name>/init</command-name>'
const EXPANSION_TEXT = 'the expanded prompt of the /init command, machine-written'
const STEER_TEXT = 'steer: also update the docs while you are at it'
const OLDER = ['older one: hello, start with the survey', 'older two: set up the repo']
const SUMMARY = [
  '<summary>',
  '1. Operator Intent: the operator wants the helper renamed, tested, wired in and written up.',
  '6. Operator Messages: the operator asked to rename the helper, to add a test, to run the suite, to fix a fixture typo, to wire the helper into the settings screen, to refactor that screen carefully, to write the changelog entry, and finally to stop and summarise.',
  '8. Where Work Stands: the changelog entry is written; the operator asked for a summary of what is left.',
  '</summary>',
].join('\n')
const SECTION_SIX = SUMMARY.split('\n')[2]!

function noiseRows(): { rows: AnyMsg[]; noise: string[] } {
  const wake = createUserMessage({ content: WAKE_TEXT, origin: { kind: 'saturn', fire: 'wake', firedAt: new Date().toISOString() } as never }) as unknown as AnyMsg
  const coordinator = createUserMessage({ content: 'coordinator: the board says go', origin: { kind: 'coordinator' } as never }) as unknown as AnyMsg
  const echo = createUserMessage({ content: ECHO_TEXT }) as unknown as AnyMsg
  const expansion = createUserMessage({ content: EXPANSION_TEXT, isMeta: true }) as unknown as AnyMsg
  const stdout = createUserMessage({ content: '<local-command-stdout>the command printed this</local-command-stdout>' }) as unknown as AnyMsg
  const bash = createUserMessage({ content: '<bash-input>ls -la</bash-input>' }) as unknown as AnyMsg
  const toolResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'the tool result text' }] as never }) as unknown as AnyMsg
  const notice = createAttachmentMessage({ type: 'queued_command', prompt: '<task-notification>agent one landed</task-notification>', commandMode: 'task-notification' } as never) as unknown as AnyMsg
  const coordinatorSteer = createAttachmentMessage({ type: 'queued_command', prompt: 'coordinator steer text', origin: { kind: 'coordinator' }, isMeta: true } as never) as unknown as AnyMsg
  const virtual = { ...(createUserMessage({ content: 'a virtual row the model never saw' }) as unknown as AnyMsg), isVirtual: true }
  const imageOnly = createUserMessage({ content: [IMAGE] as never }) as unknown as AnyMsg
  const rows = [wake, coordinator, echo, expansion, stdout, bash, toolResult, notice, coordinatorSteer, virtual, imageOnly]
  return { rows, noise: rows.map(rowText) }
}

section('A the selection law — which rows are the operator\'s own, newest first within the budget')
check(`the selection module exists (${SELECTION_MODULE})`, selection !== null, `absent on this tree: no operator-messages block is built; add ${SELECTION_MODULE} exporting selectOperatorMessages and collectOperatorTexts`)
if (selection !== null) {
  check(`the block kind is ${KIND} and the budget is a constant beside the tail's`, selection.OPERATOR_MESSAGES_ATTACHMENT_TYPE === KIND && selection.OPERATOR_MESSAGES_TOKEN_BUDGET === 20_000, `${selection.OPERATOR_MESSAGES_ATTACHMENT_TYPE} ${selection.OPERATOR_MESSAGES_TOKEN_BUDGET}; restore the kind and the 20_000 budget constants in ${SELECTION_MODULE}`)
  const prior = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 2, text: OLDER[1] }, { ordinal: 1, text: OLDER[0] }], omitted: 0 } as never) as unknown as AnyMsg
  const oldSummary = createUserMessage({ content: 'Summary:\nthe earlier stretch, paraphrased', isCompactSummary: true, isVisibleInTranscriptOnly: true }) as unknown as AnyMsg
  const oldBoundary = createFoldBoundaryMessage('auto', 100) as unknown as AnyMsg
  const { rows: noise, noise: noiseTexts } = noiseRows()
  const promptRows = PROMPTS.map(text => createUserMessage({ content: text }) as unknown as AnyMsg)
  const steer = createAttachmentMessage({ type: 'queued_command', prompt: STEER_TEXT, commandMode: 'prompt', source_uuid: uuidOf(9001) } as never) as unknown as AnyMsg
  const withImage = createUserMessage({ content: [{ type: 'text', text: 'look at this screenshot' }, IMAGE] as never }) as unknown as AnyMsg
  const history: AnyMsg[] = [
    oldBoundary, prior, oldSummary,
    promptRows[0]!, assistant(REPLIES[0]!),
    promptRows[1]!, assistant(REPLIES[1]!),
    ...noise.slice(0, 6),
    promptRows[2]!, assistant(REPLIES[2]!),
    ...noise.slice(6),
    steer,
    promptRows[3]!, assistant(REPLIES[3]!),
    withImage, assistant('I see the screenshot'),
    promptRows[4]!, assistant(REPLIES[4]!),
    promptRows[5]!, assistant(REPLIES[5]!),
    promptRows[6]!, assistant(REPLIES[6]!),
    promptRows[7]!, assistant(REPLIES[7]!),
  ]
  const expected = [PROMPTS[0]!, PROMPTS[1]!, PROMPTS[2]!, STEER_TEXT, PROMPTS[3]!, 'look at this screenshot\n[image]', PROMPTS[4]!, PROMPTS[5]!, PROMPTS[6]!, PROMPTS[7]!]
  const earlier = OLDER.length
  const texts = selection.collectOperatorTexts(history)
  check('the census: the typed prompts, the human steer and the text of a text+image row of THIS stretch, in order — a prior fold\'s block is not re-collected (its boundary record carries it whole)', j(texts) === j(expected), `${j(texts.map(t => t.slice(0, 40)))}; fix which rows collectOperatorTexts counts as the operator's own in ${SELECTION_MODULE}`)
  check('…the prior block\'s messages are counted as earlier', selection.priorOperatorMessages(history) === earlier, `${String(selection.priorOperatorMessages(history))}; priorOperatorMessages in ${SELECTION_MODULE} must count the messages of the prior block`)
  check('…a Saturn wake, a coordinator row, a command echo and its expansion, a local-command stdout row, a bash-mode row, a tool result, a task notification, a coordinator steer, a virtual row and an image-only row are out', noiseTexts.filter(noiseText => noiseText !== '').every(noiseText => !texts.some(text => text.includes(noiseText.slice(0, 24)))) && !texts.some(text => text.includes(EXPANSION_TEXT) || text.includes(WAKE_TEXT.slice(0, 20)) || text === '[image]'), `a noise row leaked into the census: ${j(texts.map(t => t.slice(0, 40)))}; exclude it in collectOperatorTexts in ${SELECTION_MODULE}`)
  check('…an earlier compaction summary and its boundary are out', !texts.some(text => text.includes('paraphrased') || text.includes('Conversation compacted')), `the earlier summary or boundary was collected: ${j(texts.map(t => t.slice(0, 40)))}; skip compact summary and boundary rows in collectOperatorTexts in ${SELECTION_MODULE}`)
  const block = selection.selectOperatorMessages(history)
  check(`the block carries every one of this stretch's messages whole (${expected.length}) and the prior fold's ${earlier} too, within the budget — nothing omitted`, block !== null && block.messages.length === expected.length + earlier && block.omitted === 0, `${j(block)}; fix selectOperatorMessages in ${SELECTION_MODULE}`)
  check('…newest first: ordinals descend from the session total, the first entry is the last prompt, the last entry is the session\'s opening message', block !== null && block.messages.every((entry, index) => entry.ordinal === earlier + expected.length - index) && block.messages[0]!.text === PROMPTS[7] && block.messages.at(-1)!.text === OLDER[0], `${j(block?.messages.map(entry => entry.ordinal))}; order and number the entries in selectOperatorMessages in ${SELECTION_MODULE}`)
  check('…the entries are the exact texts (verbatim), the earlier ones from the prior block', block !== null && block.messages.every(entry => entry.text === (entry.ordinal > earlier ? expected[entry.ordinal - earlier - 1] : OLDER[entry.ordinal - 1])), `entries differ from the verbatim texts: ${j(block?.messages.map(entry => entry.text.slice(0, 20)))}; selectOperatorMessages in ${SELECTION_MODULE} must keep each text whole`)
  const keptUuids = new Set([promptRows[5]!.uuid!, promptRows[6]!.uuid!, promptRows[7]!.uuid!])
  const withKept = selection.selectOperatorMessages(history, { keptUuids })
  check('a prompt inside the kept tail is not repeated (p6, p7, p8 kept ⇒ the block\'s newest is p5; the prior fold\'s two still ride at its end)', withKept !== null && withKept.messages.length === expected.length - 3 + earlier && withKept.messages[0]!.text === PROMPTS[4] && withKept.messages.at(-1)!.text === OLDER[0] && !withKept.messages.some(entry => entry.text === PROMPTS[5] || entry.text === PROMPTS[6] || entry.text === PROMPTS[7]), `${j(withKept?.messages.map(entry => entry.text.slice(0, 20)))}; selectOperatorMessages in ${SELECTION_MODULE} must skip the rows named in keptUuids`)
  const tokensOf = (text: string): number => Math.ceil(text.length / 4)
  const budget = tokensOf(PROMPTS[7]!) + tokensOf(PROMPTS[6]!) + 100
  const original = j(history)
  let refusal = ''
  try { selection.selectOperatorMessages(history, { tokenBudget: budget }) } catch (error) { refusal = String(error) }
  check('an insufficient budget refuses instead of cutting an operator message', refusal.includes('original context is kept'), `refusal=${j(refusal)}; selectOperatorMessages in ${SELECTION_MODULE} must throw an error saying the original context is kept when the budget is short`)
  check('the original operator history is unchanged on refusal', j(history) === original, `selectOperatorMessages in ${SELECTION_MODULE} mutated its input rows on refusal; copy before editing`)
  let tinyRefused = false
  try { selection.selectOperatorMessages(history, { tokenBudget: 5 }) } catch { tinyRefused = true }
  check('a tiny budget cannot silently discard the operator block', tinyRefused, `selectOperatorMessages in ${SELECTION_MODULE} returned instead of throwing for tokenBudget 5`)
  check('a stretch with no operator message yields no block', selection.selectOperatorMessages([oldBoundary, oldSummary, ...noise, assistant('nothing asked')]) === null, `selectOperatorMessages in ${SELECTION_MODULE} must return null when no operator text is collected`)
  check('the steer counts once even when its echo row rides beside it (source_uuid dedupe)', j(selection.collectOperatorTexts([steer, { ...(createUserMessage({ content: STEER_TEXT }) as unknown as AnyMsg), uuid: uuidOf(9001) }])) === j([STEER_TEXT]), `collectOperatorTexts in ${SELECTION_MODULE} must dedupe a steer and its echo row by source_uuid`)
}

section('B the wire projection and the registry — one meta user row, newest first, the kind known everywhere')
{
  const block: Block = {
    type: KIND,
    messages: [{ ordinal: 10, text: 'the newest ask' }, { ordinal: 9, text: 'the middle ask' }, { ordinal: 8, text: 'the oldest kept ask\n[the rest of this message is cut for the budget; the summary covers it]', truncated: true }],
    omitted: 7,
  }
  const projected = normalizeAttachmentForAPI(block as never)
  const text = projected.length === 1 ? textOf(projected[0]) : ''
  console.log(text.split('\n').map(line => `  │ ${line.slice(0, 150)}`).join('\n'))
  check('the block projects to ONE meta user row', projected.length === 1 && (projected[0] as { isMeta?: boolean }).isMeta === true, `${String(projected.length)}; the compact_operator_messages entry in src/engine/messages/attachmentText.ts must return one meta row`)
  check('…headed as the operator\'s own messages, verbatim and newest first, with the coverage spoken by ordinal', text.startsWith("The operator's own messages from this stretch and the earlier folds, verbatim and newest first (3 of 10; messages 1-7 are carried whole by the earlier folds' boundary records)"), `${text.slice(0, 200)}; fix the head line in operatorMessagesBlockText in ${SELECTION_MODULE}`)
  check('…each entry framed with its ordinal out of the total', text.includes('<operator-message ordinal="10" of="10">\nthe newest ask\n</operator-message>') && text.includes('<operator-message ordinal="8" of="10">'), `entry framing is wrong; fix operatorMessagesBlockText in ${SELECTION_MODULE}`)
  check('…newest first on the wire', text.indexOf('ordinal="10"') >= 0 && text.indexOf('ordinal="10"') < text.indexOf('ordinal="9"') && text.indexOf('ordinal="9"') >= 0 && text.indexOf('ordinal="9"') < text.indexOf('ordinal="8"'), `entries are not newest first; fix operatorMessagesBlockText in ${SELECTION_MODULE}`)
  check('…the truncated entry carries its marker', text.includes('the oldest kept ask\n[the rest of this message is cut for the budget; the summary covers it]\n</operator-message>'), `a truncated entry lost its marker; fix operatorMessagesBlockText in ${SELECTION_MODULE}`)
  check('…not wrapped in a system reminder (the operator\'s words weigh as the summary does)', !text.startsWith('<system-reminder>'), `the block text is wrapped in a system reminder; the compact_operator_messages entry in src/engine/messages/attachmentText.ts must use meta() without a reminder wrapper`)
  const whole = normalizeAttachmentForAPI({ type: KIND, messages: [{ ordinal: 1, text: 'only ask' }], omitted: 0 } as never)
  check('a whole block says so (all 1 of them)', whole.length === 1 && textOf(whole[0]).includes('(all 1 of them)'), `fix the coverage wording in operatorMessagesBlockText in ${SELECTION_MODULE}`)
  check('an empty block projects nothing', normalizeAttachmentForAPI({ type: KIND, messages: [], omitted: 0 } as never).length === 0, `the compact_operator_messages entry in src/engine/messages/attachmentText.ts must return [] for an empty block`)
  check('the kind is registered null-rendering (transcript-only, never painted — no look change)', (NULL_RENDERING_ATTACHMENT_TYPES as readonly string[]).includes(KIND) && isNullRenderingAttachment(createAttachmentMessage(block as never) as never), `add 'compact_operator_messages' to NULL_RENDERING_ATTACHMENT_TYPES in src/screen/messages/nullRenderingAttachments.ts`)
  check('the body-shape registry knows the kind', (BODY_SHAPE_KINDS.attachment as readonly string[]).includes(KIND), `add compact_operator_messages to the attachment body shapes in src/sessions/fabric/validate.ts`)
}

const CACHE_SAFE = { systemPrompt: ['fixture posture'] } as never
function makeContext(model: string): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    tasks: {},
    crewmateNameRegistry: new Map(),
    mcp: { clients: [], tools: [], commands: [], resources: {} },
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    agentId: undefined,
    readFileState: new Map<string, unknown>(),
    options: {
      tools: [],
      mcpClients: [],
      engineModel: model,
      maxThinkingTokens: 0,
      thinkingConfig: { type: 'adaptive' as const },
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [] },
    },
  }
}
function foldHistory(): AnyMsg[] {
  const out: AnyMsg[] = []
  for (let index = 0; index < PROMPTS.length; index++) {
    out.push(createUserMessage({ content: PROMPTS[index]! }) as unknown as AnyMsg)
    if (index === 2) {
      out.push(createUserMessage({ content: WAKE_TEXT, origin: { kind: 'saturn', fire: 'wake', firedAt: new Date().toISOString() } as never }) as unknown as AnyMsg)
      out.push(createUserMessage({ content: ECHO_TEXT }) as unknown as AnyMsg)
      out.push(createUserMessage({ content: EXPANSION_TEXT, isMeta: true }) as unknown as AnyMsg)
    }
    out.push(assistant(REPLIES[index]!))
  }
  return out
}
async function fold(model: string): Promise<{ result: Record<string, unknown> | undefined; error: Error | undefined }> {
  fixture.script([{ text: SUMMARY }])
  try {
    const result = (await compactMod.foldConversation(foldHistory() as never, makeContext(model) as never, CACHE_SAFE, true)) as unknown as Record<string, unknown>
    return { result, error: undefined }
  } catch (err) {
    return { result: undefined, error: err as Error }
  }
}
function betweenBoundaryAndSummary(post: AnyMsg[]): { between: AnyMsg[]; summary: AnyMsg | undefined } {
  const summaryIndex = post.findIndex(row => row.type === 'user' && (row as { isCompactSummary?: boolean }).isCompactSummary === true)
  return { between: summaryIndex > 0 ? post.slice(1, summaryIndex) : [], summary: summaryIndex >= 0 ? post[summaryIndex] : undefined }
}

section('C the real fold, no kept tail — every prompt verbatim between the boundary and the summary, newest first')
{
  process.env.MERCURY_COMPACT_KEEP_TAIL = '0'
  const { result, error } = await fold('claude-opus-4-8')
  check('compactConversation resolved on the loopback', result !== undefined && error === undefined, `${(error?.stack ?? '').slice(0, 400)}; compactConversation in src/engine/compaction/foldConversation.ts threw on the loopback fixture, read the stack`)
  if (result !== undefined) {
    const post = compactMod.buildPostFoldMessages(result as never) as unknown as AnyMsg[]
    const { between, summary } = betweenBoundaryAndSummary(post)
    const summaryText = textOf(summary)
    const betweenText = between.map(rowText).join('\n')
    check('the result carries the operator-messages row', blockOf(result.operatorMessages) !== null, `operatorMessages=${j(result.operatorMessages)}; compactConversation in src/engine/compaction/foldConversation.ts must set operatorMessages from selectOperatorMessages`)
    check('the first row is the boundary, the summary row is present', post[0]?.type === 'system' && summary !== undefined, 'buildPostCompactMessages in src/engine/compaction/fold/foldResult.ts must start with the boundary and include the summary row')
    check('the row between the boundary and the summary is the operator-messages block', between.length === 1 && blockOf(between[0]) !== null, `between the boundary and the summary: ${between.length === 0 ? 'nothing' : between.map(row => String(row.type)).join(',')}; the summary reads: "${SECTION_SIX.slice(0, 120)}…"; buildPostCompactMessages in src/engine/compaction/fold/foldResult.ts must place operatorMessages right after the boundary`)
    check('every one of the eight prompts appears VERBATIM between the boundary and the summary', PROMPTS.every(prompt => betweenText.includes(j(prompt).slice(1, -1))), `missing: ${PROMPTS.filter(prompt => !betweenText.includes(j(prompt).slice(1, -1))).map(prompt => prompt.slice(0, 24)).join(' | ')}; the model sees only the summariser's paraphrase: "${SECTION_SIX.slice(0, 160)}"; check selectOperatorMessages in ${SELECTION_MODULE} and its wiring in compactConversation (src/engine/compaction/foldConversation.ts)`)
    const block = blockOf(between[0])
    check('…newest first (p8 first, p1 last), none omitted, none truncated', block !== null && block.messages.length === 8 && block.omitted === 0 && block.messages[0]!.text === PROMPTS[7] && block.messages[7]!.text === PROMPTS[0] && block.messages.every((entry, index) => entry.ordinal === 8 - index && entry.truncated === undefined), `${j(block?.messages.map(entry => `${entry.ordinal}:${entry.text.slice(0, 12)}`))}; fix selectOperatorMessages in ${SELECTION_MODULE}`)
    check('…the wake, the command echo and its expansion did not ride', !betweenText.includes('self-paced wake') && !betweenText.includes('command-name') && !betweenText.includes(EXPANSION_TEXT), `a wake, echo or expansion row rode in the block; exclude it in collectOperatorTexts in ${SELECTION_MODULE}`)
    check('the summary still covers everything (section 6 is the summariser\'s paraphrase, the block is the exact words)', summaryText.includes(SECTION_SIX) && !summaryText.includes(PROMPTS[0]!), 'the summary row must carry the summariser text only and not the prompts; check compactConversation in src/engine/compaction/foldConversation.ts')
    const api = normalizeMessagesForAPI(post as never, [])
    const apiText = api.map(textOf).join('\n')
    check('on the wire the block precedes the summary text', apiText.indexOf("The operator's own messages") >= 0 && apiText.indexOf("The operator's own messages") < apiText.indexOf('The context window turned over'), `${apiText.slice(0, 160)}; normalizeMessagesForAPI (src/engine/messages/apiView.ts) must keep the block row ahead of the summary row`)
    check('…and every prompt is on the wire verbatim', PROMPTS.every(prompt => apiText.includes(prompt)), 'a prompt is missing on the wire; check the compact_operator_messages entry in src/engine/messages/attachmentText.ts')
    const without = { ...result, operatorMessages: undefined }
    const withBlock = estimateContextTokens(post as never)
    const withoutBlock = estimateContextTokens(compactMod.buildPostFoldMessages(without as never) as never)
    check('the size guard counts the block (the true post figure includes it)', withBlock > withoutBlock && result.truePostFoldTokenCount === withBlock, `${withBlock} vs ${withoutBlock}; true=${String(result.truePostFoldTokenCount)}; estimateContextTokens (src/engine/compaction/pruneToolResults.ts) and truePostFoldTokenCount in src/engine/compaction/foldConversation.ts must both count the block`)
  }
}

section('D the real fold with the kept tail — a prompt inside the tail is not repeated in the block')
{
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  const { result, error } = await fold('claude-opus-4-8')
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  check('compactConversation resolved on the loopback', result !== undefined && error === undefined, `${(error?.stack ?? '').slice(0, 400)}; compactConversation in src/engine/compaction/foldConversation.ts threw on the loopback fixture with MERCURY_COMPACT_KEEP_TAIL=1, read the stack`)
  if (result !== undefined) {
    const kept = (result.messagesToKeep ?? []) as AnyMsg[]
    const keptText = kept.map(rowText).join('\n')
    const inTail = PROMPTS.filter(prompt => keptText.includes(prompt))
    const folded = PROMPTS.filter(prompt => !keptText.includes(prompt))
    check('the verbatim tail kept the last rounds (some prompts ride in the tail, some were folded)', kept.length > 0 && inTail.length > 0 && folded.length > 0, `tail=${inTail.length} folded=${folded.length}; with MERCURY_COMPACT_KEEP_TAIL=1 some prompts must ride the kept tail and the rest be folded`)
    const post = compactMod.buildPostFoldMessages(result as never) as unknown as AnyMsg[]
    const { between } = betweenBoundaryAndSummary(post)
    const block = blockOf(between[0])
    check('the block sits between the boundary and the summary', between.length === 1 && block !== null, `between: ${between.map(row => String(row.type)).join(',') || 'nothing'}; buildPostCompactMessages in src/engine/compaction/fold/foldResult.ts must place operatorMessages after the boundary`)
    check('…and carries exactly the folded prompts, newest first', block !== null && j(block.messages.map(entry => entry.text)) === j([...folded].reverse()), `${j(block?.messages.map(entry => entry.text.slice(0, 12)))}; the block must hold exactly the folded prompts: fix selectOperatorMessages in ${SELECTION_MODULE} and the keptUuids passed to it in src/engine/compaction/foldConversation.ts`)
    check('…no prompt of the kept tail is repeated in it', block !== null && !block.messages.some(entry => inTail.includes(entry.text)), `a kept-tail prompt was repeated in the block; selectOperatorMessages in ${SELECTION_MODULE} must skip keptUuids`)
    check('the kept tail rows come after the summary, whole', post.findIndex(row => row.uuid === kept[0]?.uuid) > post.findIndex(row => (row as { isCompactSummary?: boolean }).isCompactSummary === true), 'buildPostCompactMessages in src/engine/compaction/fold/foldResult.ts must put messagesToKeep after the summaryMessages')
  }
}

section('E a second fold carries this stretch\'s prompts whole and the first block\'s with them, the opening message first — one block on the wire, the budget the only cut')
if (selection !== null) {
  const firstBlock = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 3, text: 'first fold ask three' }, { ordinal: 2, text: 'first fold ask two' }, { ordinal: 1, text: 'first fold ask one' }], omitted: 0 } as never) as unknown as AnyMsg
  const history = [
    createFoldBoundaryMessage('auto', 100) as unknown as AnyMsg,
    firstBlock,
    createUserMessage({ content: 'Summary:\nthe first stretch', isCompactSummary: true, isVisibleInTranscriptOnly: true }) as unknown as AnyMsg,
    createUserMessage({ content: 'second stretch ask four' }) as unknown as AnyMsg,
    assistant('did four'),
    createUserMessage({ content: 'second stretch ask five' }) as unknown as AnyMsg,
    assistant('did five'),
  ]
  const block = selection.selectOperatorMessages(history)
  check('the second block: the new prompts newest first, ordinals continuing the session count, then the first block\'s three — nothing omitted within the budget', block !== null && j(block.messages.map(entry => [entry.ordinal, entry.text])) === j([[5, 'second stretch ask five'], [4, 'second stretch ask four'], [3, 'first fold ask three'], [2, 'first fold ask two'], [1, 'first fold ask one']]) && block.omitted === 0, `${j(block)}; fix selectOperatorMessages in ${SELECTION_MODULE} (ordinals continue the session count, the prior block's entries follow)`)
  check('…the wire head says so', block !== null && selection.operatorMessagesBlockText(block).includes('(all 5 of them)'), block === null ? '' : `${selection.operatorMessagesBlockText(block).slice(0, 220)}; fix the coverage wording in operatorMessagesBlockText in ${SELECTION_MODULE}`)
  const wide = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 3, text: 'x'.repeat(100_000) }, { ordinal: 2, text: 'y'.repeat(100_000) }, { ordinal: 1, text: 'the opening ask' }], omitted: 0 } as never) as unknown as AnyMsg
  const cut = selection.selectOperatorMessages([history[0]!, wide, history[2]!, ...history.slice(3)])
  check('over the budget the opening message rides first and the newest of the rest next; what the budget leaves out is named by ordinal', cut !== null && j(cut.messages.map(entry => entry.ordinal)) === j([5, 4, 1]) && cut.omitted === 2 && selection.operatorMessagesBlockText(cut).includes('(3 of 5; messages 2-3 are carried whole by the earlier folds\' boundary records)'), cut === null ? '' : `${j(cut.messages.map(entry => entry.ordinal))} ${selection.operatorMessagesBlockText(cut).slice(0, 200)}; selectOperatorMessages in ${SELECTION_MODULE} must keep the opening message first and name the omitted ordinals in operatorMessagesBlockText`)
  check('…the first summary itself is excluded', block !== null && !block.messages.some(entry => entry.text.includes('first stretch')), `the earlier compaction summary was collected; skip compact summary rows in collectOperatorTexts in ${SELECTION_MODULE}`)
}

section('F the size guard sheds the block LAST, before refusing; a fitting result keeps it')
{
  const fileAttachment = (name: string, chars: number): AnyMsg =>
    createAttachmentMessage({ type: 'file', filename: `/rig/${name}`, displayPath: name, content: { type: 'text', file: { filePath: `/rig/${name}`, content: 'x'.repeat(chars), numLines: 1, startLine: 1, totalLines: 1 } } } as never) as unknown as AnyMsg
  const skills = createAttachmentMessage({ type: 'invoked_skills', skills: [{ name: 'rig-skill', path: '/rig/SKILL.md', content: 's'.repeat(2_000) }] } as never) as unknown as AnyMsg
  const block = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 2, text: 'b'.repeat(2_000) }, { ordinal: 1, text: 'a'.repeat(2_000) }], omitted: 0 } as never) as unknown as AnyMsg
  const rig = (attachments: AnyMsg[], operatorMessages: AnyMsg | undefined): Record<string, unknown> => ({
    boundaryMarker: createFoldBoundaryMessage('auto', 150_000),
    operatorMessages,
    summaryMessages: [createUserMessage({ content: `RIG SUMMARY ${'of the folded history. '.repeat(20)}`, isCompactSummary: true, isVisibleInTranscriptOnly: true })],
    attachments,
    hookResults: [],
    preFoldTokenCount: 150_000,
    postFoldTokenCount: 0,
    foldUsage: undefined,
  })
  const full = rig([fileAttachment('A.txt', 4_000), skills], block)
  const core = estimateContextTokens(compactMod.buildPostFoldMessages(rig([], undefined) as never) as never)
  const coreWithBlock = estimateContextTokens(compactMod.buildPostFoldMessages(rig([], block) as never) as never)
  check('the block weighs in the whole-context estimate', coreWithBlock > core, `${coreWithBlock} vs ${core}; buildPostCompactMessages in src/engine/compaction/fold/foldResult.ts must include operatorMessages and estimateContextTokens (src/engine/compaction/pruneToolResults.ts) must count it`)
  const out = compactMod.fitPostFoldUnderThreshold(full as never, coreWithBlock) as { result: { operatorMessages?: unknown; attachments: unknown[] }; estimate: number; shed: string[] }
  check('files and skills may go; operator bytes stand even when the fit must refuse', j(out.shed) === j(['file /rig/A.txt', 'invoked_skills']) && out.result.operatorMessages === block && out.estimate >= coreWithBlock, `${j({ shed: out.shed, estimate: out.estimate, threshold: coreWithBlock })}; fitPostCompactUnderThreshold in src/engine/compaction/fold/foldAttachments.ts may shed files and skills but never operatorMessages`)
  const roomy = compactMod.fitPostFoldUnderThreshold(full as never, coreWithBlock + 100_000) as { result: { operatorMessages?: unknown }; shed: string[] }
  check('a result under the threshold keeps its block (nothing shed)', roomy.shed.length === 0 && roomy.result.operatorMessages === block, `fitPostCompactUnderThreshold in src/engine/compaction/fold/foldAttachments.ts shed ${j(roomy.shed)} although the result fit the threshold`)
  const tight = compactMod.fitPostFoldUnderThreshold(rig([fileAttachment('A.txt', 4_000)], block) as never, coreWithBlock + 50) as { result: { operatorMessages?: unknown }; shed: string[]; estimate: number }
  check('when shedding the file alone brings the fit under, the block stands', j(tight.shed) === j(['file /rig/A.txt']) && tight.result.operatorMessages === block && tight.estimate < coreWithBlock + 50, `${j(tight.shed)}; fitPostCompactUnderThreshold in src/engine/compaction/fold/foldAttachments.ts must stop shedding once the estimate is under the threshold and keep operatorMessages`)
}

section('G the resume road — the block survives a reload the way the summary does')
{
  type Row = AnyMsg & { parentUuid: string | null; isSidechain: boolean }
  const row = (message: AnyMsg, parentUuid: string | null): Row => ({ ...message, parentUuid, isSidechain: false })
  const u1 = createUserMessage({ content: 'before the fold, one' }) as unknown as AnyMsg
  const a1 = assistant('answered one')
  const u2 = createUserMessage({ content: 'before the fold, two' }) as unknown as AnyMsg
  const a2 = assistant('answered two')
  const block = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 1, text: 'before the fold, one' }], omitted: 0 } as never) as unknown as AnyMsg
  const summary = createUserMessage({ content: 'Summary:\nthe folded stretch', isCompactSummary: true, isVisibleInTranscriptOnly: true }) as unknown as AnyMsg
  const boundary = createFoldBoundaryMessage('auto', 5_000) as unknown as AnyMsg
  ;(boundary as { compactMetadata: Record<string, unknown> }).compactMetadata.preservedSegment = { headUuid: u2.uuid, anchorUuid: summary.uuid, tailUuid: a2.uuid }
  const u3 = createUserMessage({ content: 'after the fold' }) as unknown as AnyMsg
  const a3 = assistant('answered after the fold')
  const rows: Row[] = [row(u1, null), row(a1, u1.uuid!), row(u2, a1.uuid!), row(a2, u2.uuid!), row(boundary, null), row(block, boundary.uuid!), row(summary, block.uuid!), row(u3, summary.uuid!), row(a3, u3.uuid!)]
  const map = new Map(rows.map(r => [r.uuid as never, r as never]))
  chain.applyPreservedSegmentRelinks(map as never)
  const loaded = chain.buildConversationChain(map as never, map.get(a3.uuid as never) as never) as unknown as AnyMsg[]
  const order = loaded.map(m => (m.uuid === boundary.uuid ? 'boundary' : m.uuid === block.uuid ? 'block' : m.uuid === summary.uuid ? 'summary' : m.uuid === u1.uuid ? 'u1' : m.uuid === a1.uuid ? 'a1' : m.uuid === u2.uuid ? 'u2' : m.uuid === a2.uuid ? 'a2' : m.uuid === u3.uuid ? 'u3' : 'a3'))
  check('the reloaded chain: boundary, block, summary, the kept tail, the later turn — the folded head pruned', j(order) === j(['boundary', 'block', 'summary', 'u2', 'a2', 'u3', 'a3']), `${j(order)}; applyPreservedSegmentRelinks and buildConversationChain in src/sessions/transcripts/chain.ts must rebuild the chain boundary, block, summary, kept tail, later turn`)
  check('the block is a loggable row (it projects to the wire, so the file keeps it)', chain.isTranscribable(block as never) === true, 'isTranscribable in src/sessions/transcripts/chain.ts must accept the compact_operator_messages attachment')
  check('an empty block is not persisted (it projects nothing)', chain.isTranscribable(createAttachmentMessage({ type: KIND, messages: [], omitted: 0 } as never) as never) === false, 'isTranscribable in src/sessions/transcripts/chain.ts must reject an empty compact_operator_messages block')
}

section('H the turn machine end to end — the retried request after an overflow fold carries the asks verbatim, ahead of the summary')
{
  const OPERATOR_ASK = 'operator ask: land the change and run its checks'
  const asks = [0, 1, 2, 3, 4].map(index => `ask ${index}: adjust module ${index} and keep the notes tidy`)
  const seedRows: AnyMsg[] = []
  asks.forEach((ask, index) => {
    seedRows.push(createUserMessage({ content: ask }) as unknown as AnyMsg)
    seedRows.push(assistant(`reply ${index}: module ${index} adjusted and its checks pass`))
  })
  seedRows.push(createUserMessage({ content: OPERATOR_ASK }) as unknown as AnyMsg)
  const shape = OVERFLOW_WIRE_SHAPES.anthropic!
  const SUMMARY_H = 'SUMMARY: the earlier modules were adjusted and their checks pass; the operator asked for five adjustments in turn.'
  fixture.script([
    { error: { status: shape.status, body: shape.body } },
    { text: SUMMARY_H },
    { text: 'the recovered answer', usage: { input: 640, output: 12 } },
  ])
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const ctx = {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
  const before = fixture.captured.length
  let threw: string | undefined
  let terminal: Record<string, unknown> = {}
  const yields: AnyMsg[] = []
  try {
    const gen = turnDoor({
      messages: seedRows as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async () => ({ behavior: 'deny', message: 'no tools in this rig' })) as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      deps: productionDeps(),
    })
    let r = await gen.next()
    while (!r.done) {
      yields.push(r.value as AnyMsg)
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  const wire = fixture.captured.slice(before)
  check('the run completed: overflow, the fold, the retry, a reply', threw === undefined && terminal.reason === 'completed' && wire.length === 3, `threw=${threw ?? 'no'} terminal=${j(terminal)} wire=${wire.length}`)
  const retry = wire[2]
  const body = retry !== undefined ? j(retry.body) : ''
  const firstUser = ((retry?.body as { messages?: AnyMsg[] } | undefined)?.messages ?? [])[0]
  const firstText = wireTextOf(firstUser)
  check('the retried request carries every folded ask VERBATIM', asks.every(ask => body.includes(ask)), `missing: ${asks.filter(ask => !body.includes(ask)).join(' | ')}; the first user row opens: "${firstText.slice(0, 140)}"`)
  const foldedAsks = [...asks].reverse().filter(ask => firstText.includes(ask))
  check('…folded asks precede the summary newest first; recent asks ride the kept rounds', foldedAsks.length > 0 && foldedAsks.every((ask, index) => firstText.indexOf(ask) < firstText.indexOf(SUMMARY_H) && (index === 0 || firstText.indexOf(foldedAsks[index - 1]!) < firstText.indexOf(ask))), `first user row of the retried request: "${firstText.slice(0, 200)}"; the block must precede the summary and list asks newest first (selectOperatorMessages in ${SELECTION_MODULE})`)
  check('…the folded replies do not ride (the summary covers them)', !body.includes('reply 0: module 0 adjusted'), 'a folded assistant reply rode on the retried request; the fold must replace them with the summary')
  check('…and the carried operator turn still rides last', retry !== undefined && wireTextOf(((retry.body as { messages?: AnyMsg[] }).messages ?? []).at(-1)).endsWith(OPERATOR_ASK), `the retried request's last message does not end with the carried operator turn; last row: "${wireTextOf(((retry?.body as { messages?: AnyMsg[] } | undefined)?.messages ?? []).at(-1)).slice(-120)}"`)
  check('the block row yields with the boundary and the summary', yields.some(y => blockOf(y) !== null) && yields.some(y => y.type === 'user' && (y as { isCompactSummary?: boolean }).isCompactSummary === true), `query yielded ${yields.length} rows without both the operator-messages block and the compact summary; the overflow fold must yield them with the boundary`)
}


await fixture.close()
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
