#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE', 'MERCURY_HOME', 'GOOGLE_API_KEY', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_OVERFLOW_RECOVERY',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_THINKING_BINDING', 'MERCURY_SM_COMPACT',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'compact-operator-messages-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'compact-operator-messages-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'compact-operator-messages-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
const SELECTION_MODULE = 'src/services/compact/operatorMessages.ts'
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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
const { NULL_RENDERING_ATTACHMENT_TYPES, isNullRenderingAttachment } = await import('../../src/components/messages/nullRenderingAttachments.ts')
const { BODY_SHAPE_KINDS } = await import('../../src/fabric/validate.ts')
const { estimateContextTokens } = await import('../../src/services/compact/microCompact.ts')
const compactMod = await import('../../src/services/compact/compact.ts')
const chain = await import('../../src/utils/sessionStorage/chain.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')

type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string }
type Entry = { ordinal: number; text: string; truncated?: boolean }
type Block = { type: string; messages: Entry[]; omitted: number }
type Selection = {
  selectOperatorMessages: (messages: unknown[], opts?: { keptUuids?: ReadonlySet<string>; tokenBudget?: number }) => Block | null
  collectOperatorTexts: (messages: unknown[], keptUuids?: ReadonlySet<string>) => string[]
  operatorMessagesBlockText: (attachment: Block) => string
  OPERATOR_MESSAGES_TOKEN_BUDGET: number
  OPERATOR_MESSAGE_TRUNCATION_MARKER: string
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
check(`the selection module exists (${SELECTION_MODULE})`, selection !== null, 'absent on this tree: no operator-messages block is built')
if (selection !== null) {
  check(`the block kind is ${KIND} and the budget is a constant beside the tail's`, selection.OPERATOR_MESSAGES_ATTACHMENT_TYPE === KIND && selection.OPERATOR_MESSAGES_TOKEN_BUDGET === 20_000, `${selection.OPERATOR_MESSAGES_ATTACHMENT_TYPE} ${selection.OPERATOR_MESSAGES_TOKEN_BUDGET}`)
  const prior = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 2, text: OLDER[1] }, { ordinal: 1, text: OLDER[0] }], omitted: 0 } as never) as unknown as AnyMsg
  const oldSummary = createUserMessage({ content: 'Summary:\nthe earlier stretch, paraphrased', isCompactSummary: true, isVisibleInTranscriptOnly: true }) as unknown as AnyMsg
  const oldBoundary = createCompactBoundaryMessage('auto', 100) as unknown as AnyMsg
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
  const expected = [...OLDER, PROMPTS[0]!, PROMPTS[1]!, PROMPTS[2]!, STEER_TEXT, PROMPTS[3]!, 'look at this screenshot\n[image]', PROMPTS[4]!, PROMPTS[5]!, PROMPTS[6]!, PROMPTS[7]!]
  const texts = selection.collectOperatorTexts(history)
  check('the census: the typed prompts, the human steer, the text of a text+image row, and a prior block\'s entries — in order', j(texts) === j(expected), j(texts.map(t => t.slice(0, 40))))
  check('…a Saturn wake, a coordinator row, a command echo and its expansion, a local-command stdout row, a bash-mode row, a tool result, a task notification, a coordinator steer, a virtual row and an image-only row are out', noiseTexts.filter(noiseText => noiseText !== '').every(noiseText => !texts.some(text => text.includes(noiseText.slice(0, 24)))) && !texts.some(text => text.includes(EXPANSION_TEXT) || text.includes(WAKE_TEXT.slice(0, 20)) || text === '[image]'))
  check('…an earlier compaction summary and its boundary are out', !texts.some(text => text.includes('paraphrased') || text.includes('Conversation compacted')))
  const block = selection.selectOperatorMessages(history)
  check('the block carries every one of them when the budget allows (12 shown, none omitted)', block !== null && block.messages.length === expected.length && block.omitted === 0, j(block))
  check('…newest first: ordinals descend, the first entry is the last prompt, the last entry is the oldest carried one', block !== null && block.messages.every((entry, index) => entry.ordinal === expected.length - index) && block.messages[0]!.text === PROMPTS[7] && block.messages.at(-1)!.text === OLDER[0], j(block?.messages.map(entry => entry.ordinal)))
  check('…the entries are the exact texts (verbatim)', block !== null && block.messages.every(entry => entry.text === expected[entry.ordinal - 1]))
  const keptUuids = new Set([promptRows[5]!.uuid!, promptRows[6]!.uuid!, promptRows[7]!.uuid!])
  const withKept = selection.selectOperatorMessages(history, { keptUuids })
  check('a prompt inside the kept tail is not repeated (p6, p7, p8 kept ⇒ the block stops at p5)', withKept !== null && withKept.messages.length === expected.length - 3 && withKept.messages[0]!.text === PROMPTS[4] && !withKept.messages.some(entry => entry.text === PROMPTS[5] || entry.text === PROMPTS[6] || entry.text === PROMPTS[7]), j(withKept?.messages.map(entry => entry.text.slice(0, 20))))
  const tokensOf = (text: string): number => Math.ceil(text.length / 4)
  const budget = tokensOf(PROMPTS[7]!) + tokensOf(PROMPTS[6]!) + 100
  const cut = selection.selectOperatorMessages(history, { tokenBudget: budget })
  const oldestKept = cut?.messages.at(-1)
  check('within a budget: the newest ride whole, the oldest kept one is truncated with the one-clause marker, the rest are counted as omitted', cut !== null && cut.messages.length === 3 && cut.messages[0]!.text === PROMPTS[7] && cut.messages[1]!.text === PROMPTS[6] && oldestKept?.truncated === true && oldestKept.text.endsWith(selection.OPERATOR_MESSAGE_TRUNCATION_MARKER) && oldestKept.text.startsWith('p6: refactor the settings screen carefully') && oldestKept.text.length < PROMPTS[5]!.length && cut.omitted === expected.length - 3, j(cut))
  check('…the truncated entry keeps the head of the message and fits the budget', cut !== null && cut.messages.reduce((sum, entry) => sum + tokensOf(entry.text), 0) <= budget, String(cut?.messages.reduce((sum, entry) => sum + tokensOf(entry.text), 0)))
  check('a budget too small for even one clause of the newest yields no block', selection.selectOperatorMessages(history, { tokenBudget: 5 }) === null)
  check('a stretch with no operator message yields no block', selection.selectOperatorMessages([oldBoundary, oldSummary, ...noise, assistant('nothing asked')]) === null)
  check('the steer counts once even when its echo row rides beside it (source_uuid dedupe)', j(selection.collectOperatorTexts([steer, { ...(createUserMessage({ content: STEER_TEXT }) as unknown as AnyMsg), uuid: uuidOf(9001) }])) === j([STEER_TEXT]))
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
  check('the block projects to ONE meta user row', projected.length === 1 && (projected[0] as { isMeta?: boolean }).isMeta === true, String(projected.length))
  check('…headed as the operator\'s own messages, verbatim and newest first, with the coverage spoken', text.startsWith("The operator's own messages from the stretch folded into the summary below, verbatim and newest first (the newest 3 of 10; messages 1-7 are left to the summary)"))
  check('…each entry framed with its ordinal out of the total', text.includes('<operator-message ordinal="10" of="10">\nthe newest ask\n</operator-message>') && text.includes('<operator-message ordinal="8" of="10">'))
  check('…newest first on the wire', text.indexOf('ordinal="10"') >= 0 && text.indexOf('ordinal="10"') < text.indexOf('ordinal="9"') && text.indexOf('ordinal="9"') >= 0 && text.indexOf('ordinal="9"') < text.indexOf('ordinal="8"'))
  check('…the truncated entry carries its marker', text.includes('the oldest kept ask\n[the rest of this message is cut for the budget; the summary covers it]\n</operator-message>'))
  check('…not wrapped in a system reminder (the operator\'s words weigh as the summary does)', !text.startsWith('<system-reminder>'))
  const whole = normalizeAttachmentForAPI({ type: KIND, messages: [{ ordinal: 1, text: 'only ask' }], omitted: 0 } as never)
  check('a whole block says so (all 1 of them)', whole.length === 1 && textOf(whole[0]).includes('(all 1 of them)'))
  check('an empty block projects nothing', normalizeAttachmentForAPI({ type: KIND, messages: [], omitted: 0 } as never).length === 0)
  check('the kind is registered null-rendering (transcript-only, never painted — no look change)', (NULL_RENDERING_ATTACHMENT_TYPES as readonly string[]).includes(KIND) && isNullRenderingAttachment(createAttachmentMessage(block as never) as never))
  check('the body-shape registry knows the kind', (BODY_SHAPE_KINDS.attachment as readonly string[]).includes(KIND))
  const fixtureSource = readFileSync(join(ROOT, 'scripts/idiom/prove-body-shape-registry.ts'), 'utf8')
  check('the registry fixture table carries the kind', fixtureSource.includes(`${KIND}: {`))
}

const CACHE_SAFE = { systemPrompt: ['fixture posture'] } as never
function makeContext(model: string): Record<string, unknown> {
  const toolPermissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
  const appState = {
    toolPermissionContext,
    sessionHooks: new Map(),
    denialTracking: undefined,
    tasks: {},
    agentNameRegistry: new Map(),
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
      mainLoopModel: model,
      maxThinkingTokens: 0,
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
    const result = (await compactMod.compactConversation(foldHistory() as never, makeContext(model) as never, CACHE_SAFE, true)) as unknown as Record<string, unknown>
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
  check('compactConversation resolved on the loopback', result !== undefined && error === undefined, (error?.stack ?? '').slice(0, 400))
  if (result !== undefined) {
    const post = compactMod.buildPostCompactMessages(result as never) as unknown as AnyMsg[]
    const { between, summary } = betweenBoundaryAndSummary(post)
    const summaryText = textOf(summary)
    const betweenText = between.map(rowText).join('\n')
    check('the result carries the operator-messages row', blockOf(result.operatorMessages) !== null, `operatorMessages=${j(result.operatorMessages)}`)
    check('the first row is the boundary, the summary row is present', post[0]?.type === 'system' && summary !== undefined)
    check('the row between the boundary and the summary is the operator-messages block', between.length === 1 && blockOf(between[0]) !== null, `between the boundary and the summary: ${between.length === 0 ? 'nothing' : between.map(row => String(row.type)).join(',')}; the summary reads: "${SECTION_SIX.slice(0, 120)}…"`)
    check('every one of the eight prompts appears VERBATIM between the boundary and the summary', PROMPTS.every(prompt => betweenText.includes(j(prompt).slice(1, -1))), `missing: ${PROMPTS.filter(prompt => !betweenText.includes(j(prompt).slice(1, -1))).map(prompt => prompt.slice(0, 24)).join(' | ')}; the model sees only the summariser's paraphrase: "${SECTION_SIX.slice(0, 160)}"`)
    const block = blockOf(between[0])
    check('…newest first (p8 first, p1 last), none omitted, none truncated', block !== null && block.messages.length === 8 && block.omitted === 0 && block.messages[0]!.text === PROMPTS[7] && block.messages[7]!.text === PROMPTS[0] && block.messages.every((entry, index) => entry.ordinal === 8 - index && entry.truncated === undefined), j(block?.messages.map(entry => `${entry.ordinal}:${entry.text.slice(0, 12)}`)))
    check('…the wake, the command echo and its expansion did not ride', !betweenText.includes('self-paced wake') && !betweenText.includes('command-name') && !betweenText.includes(EXPANSION_TEXT))
    check('the summary still covers everything (section 6 is the summariser\'s paraphrase, the block is the exact words)', summaryText.includes(SECTION_SIX) && !summaryText.includes(PROMPTS[0]!))
    const api = normalizeMessagesForAPI(post as never, [])
    const apiText = api.map(textOf).join('\n')
    check('on the wire the block precedes the summary text', apiText.indexOf("The operator's own messages") >= 0 && apiText.indexOf("The operator's own messages") < apiText.indexOf('The context window turned over'), apiText.slice(0, 160))
    check('…and every prompt is on the wire verbatim', PROMPTS.every(prompt => apiText.includes(prompt)))
    const without = { ...result, operatorMessages: undefined }
    const withBlock = estimateContextTokens(post as never)
    const withoutBlock = estimateContextTokens(compactMod.buildPostCompactMessages(without as never) as never)
    check('the size guard counts the block (the true post figure includes it)', withBlock > withoutBlock && result.truePostCompactTokenCount === withBlock, `${withBlock} vs ${withoutBlock}; true=${String(result.truePostCompactTokenCount)}`)
  }
}

section('D the real fold with the kept tail — a prompt inside the tail is not repeated in the block')
{
  process.env.MERCURY_COMPACT_KEEP_TAIL = '1'
  const { result, error } = await fold('claude-opus-4-8')
  delete process.env.MERCURY_COMPACT_KEEP_TAIL
  check('compactConversation resolved on the loopback', result !== undefined && error === undefined, (error?.stack ?? '').slice(0, 400))
  if (result !== undefined) {
    const kept = (result.messagesToKeep ?? []) as AnyMsg[]
    const keptText = kept.map(rowText).join('\n')
    const inTail = PROMPTS.filter(prompt => keptText.includes(prompt))
    const folded = PROMPTS.filter(prompt => !keptText.includes(prompt))
    check('the verbatim tail kept the last rounds (some prompts ride in the tail, some were folded)', kept.length > 0 && inTail.length > 0 && folded.length > 0, `tail=${inTail.length} folded=${folded.length}`)
    const post = compactMod.buildPostCompactMessages(result as never) as unknown as AnyMsg[]
    const { between } = betweenBoundaryAndSummary(post)
    const block = blockOf(between[0])
    check('the block sits between the boundary and the summary', between.length === 1 && block !== null, `between: ${between.map(row => String(row.type)).join(',') || 'nothing'}`)
    check('…and carries exactly the folded prompts, newest first', block !== null && j(block.messages.map(entry => entry.text)) === j([...folded].reverse()), j(block?.messages.map(entry => entry.text.slice(0, 12))))
    check('…no prompt of the kept tail is repeated in it', block !== null && !block.messages.some(entry => inTail.includes(entry.text)))
    check('the kept tail rows come after the summary, whole', post.findIndex(row => row.uuid === kept[0]?.uuid) > post.findIndex(row => (row as { isCompactSummary?: boolean }).isCompactSummary === true))
  }
}

section('E a second fold carries the first block\'s prompts forward, newest first within the budget')
if (selection !== null) {
  const firstBlock = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 3, text: 'first fold ask three' }, { ordinal: 2, text: 'first fold ask two' }, { ordinal: 1, text: 'first fold ask one' }], omitted: 0 } as never) as unknown as AnyMsg
  const history = [
    createCompactBoundaryMessage('auto', 100) as unknown as AnyMsg,
    firstBlock,
    createUserMessage({ content: 'Summary:\nthe first stretch', isCompactSummary: true, isVisibleInTranscriptOnly: true }) as unknown as AnyMsg,
    createUserMessage({ content: 'second stretch ask four' }) as unknown as AnyMsg,
    assistant('did four'),
    createUserMessage({ content: 'second stretch ask five' }) as unknown as AnyMsg,
    assistant('did five'),
  ]
  const block = selection.selectOperatorMessages(history)
  check('the second block: the new prompts first, then the first block\'s entries, oldest last', block !== null && j(block.messages.map(entry => entry.text)) === j(['second stretch ask five', 'second stretch ask four', 'first fold ask three', 'first fold ask two', 'first fold ask one']) && block.omitted === 0, j(block))
  check('…the first summary itself is excluded', block !== null && !block.messages.some(entry => entry.text.includes('first stretch')))
}

section('F the size guard sheds the block LAST, before refusing; a fitting result keeps it')
{
  const fileAttachment = (name: string, chars: number): AnyMsg =>
    createAttachmentMessage({ type: 'file', filename: `/rig/${name}`, displayPath: name, content: { type: 'text', file: { filePath: `/rig/${name}`, content: 'x'.repeat(chars), numLines: 1, startLine: 1, totalLines: 1 } } } as never) as unknown as AnyMsg
  const skills = createAttachmentMessage({ type: 'invoked_skills', skills: [{ name: 'rig-skill', path: '/rig/SKILL.md', content: 's'.repeat(2_000) }] } as never) as unknown as AnyMsg
  const plan = createAttachmentMessage({ type: 'plan_file_reference', planFilePath: '/rig/plan.md', planContent: 'p'.repeat(800) } as never) as unknown as AnyMsg
  const block = createAttachmentMessage({ type: KIND, messages: [{ ordinal: 2, text: 'b'.repeat(2_000) }, { ordinal: 1, text: 'a'.repeat(2_000) }], omitted: 0 } as never) as unknown as AnyMsg
  const rig = (attachments: AnyMsg[], operatorMessages: AnyMsg | undefined): Record<string, unknown> => ({
    boundaryMarker: createCompactBoundaryMessage('auto', 150_000),
    operatorMessages,
    summaryMessages: [createUserMessage({ content: `RIG SUMMARY ${'of the folded history. '.repeat(20)}`, isCompactSummary: true, isVisibleInTranscriptOnly: true })],
    attachments,
    hookResults: [],
    preCompactTokenCount: 150_000,
    postCompactTokenCount: 0,
    compactionUsage: undefined,
  })
  const full = rig([fileAttachment('A.txt', 4_000), skills, plan], block)
  const core = estimateContextTokens(compactMod.buildPostCompactMessages(rig([], undefined) as never) as never)
  const coreWithBlock = estimateContextTokens(compactMod.buildPostCompactMessages(rig([], block) as never) as never)
  check('the block weighs in the whole-context estimate', coreWithBlock > core, `${coreWithBlock} vs ${core}`)
  const out = compactMod.fitPostCompactUnderThreshold(full as never, coreWithBlock) as { result: { operatorMessages?: unknown; attachments: unknown[] }; estimate: number; shed: string[] }
  check('files, skills and the plan go first; the block goes last; the fit then reports under', j(out.shed) === j(['file /rig/A.txt', 'invoked_skills', 'plan /rig/plan.md', 'operator messages']) && out.result.operatorMessages === undefined && out.estimate < coreWithBlock, j({ shed: out.shed, estimate: out.estimate, threshold: coreWithBlock }))
  const roomy = compactMod.fitPostCompactUnderThreshold(full as never, coreWithBlock + 100_000) as { result: { operatorMessages?: unknown }; shed: string[] }
  check('a result under the threshold keeps its block (nothing shed)', roomy.shed.length === 0 && roomy.result.operatorMessages === block)
  const tight = compactMod.fitPostCompactUnderThreshold(rig([fileAttachment('A.txt', 4_000)], block) as never, coreWithBlock + 50) as { result: { operatorMessages?: unknown }; shed: string[]; estimate: number }
  check('when shedding the file alone brings the fit under, the block stands', j(tight.shed) === j(['file /rig/A.txt']) && tight.result.operatorMessages === block && tight.estimate < coreWithBlock + 50, j(tight.shed))
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
  const boundary = createCompactBoundaryMessage('auto', 5_000) as unknown as AnyMsg
  ;(boundary as { compactMetadata: Record<string, unknown> }).compactMetadata.preservedSegment = { headUuid: u2.uuid, anchorUuid: summary.uuid, tailUuid: a2.uuid }
  const u3 = createUserMessage({ content: 'after the fold' }) as unknown as AnyMsg
  const a3 = assistant('answered after the fold')
  const rows: Row[] = [row(u1, null), row(a1, u1.uuid!), row(u2, a1.uuid!), row(a2, u2.uuid!), row(boundary, null), row(block, boundary.uuid!), row(summary, block.uuid!), row(u3, summary.uuid!), row(a3, u3.uuid!)]
  const map = new Map(rows.map(r => [r.uuid as never, r as never]))
  chain.applyPreservedSegmentRelinks(map as never)
  const loaded = chain.buildConversationChain(map as never, map.get(a3.uuid as never) as never) as unknown as AnyMsg[]
  const order = loaded.map(m => (m.uuid === boundary.uuid ? 'boundary' : m.uuid === block.uuid ? 'block' : m.uuid === summary.uuid ? 'summary' : m.uuid === u1.uuid ? 'u1' : m.uuid === a1.uuid ? 'a1' : m.uuid === u2.uuid ? 'u2' : m.uuid === a2.uuid ? 'a2' : m.uuid === u3.uuid ? 'u3' : 'a3'))
  check('the reloaded chain: boundary, block, summary, the kept tail, the later turn — the folded head pruned', j(order) === j(['boundary', 'block', 'summary', 'u2', 'a2', 'u3', 'a3']), j(order))
  check('the block is a loggable row (it projects to the wire, so the file keeps it)', chain.isLoggableMessage(block as never) === true)
  check('an empty block is not persisted (it projects nothing)', chain.isLoggableMessage(createAttachmentMessage({ type: KIND, messages: [], omitted: 0 } as never) as never) === false)
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
    options: { commands: [], tools: [], mainLoopModel: 'claude-opus-4-8', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
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
    const gen = query({
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
  check('…ahead of the summary, newest first', firstText.indexOf(asks[4]!) >= 0 && firstText.indexOf(asks[4]!) < firstText.indexOf(asks[0]!) && firstText.indexOf(asks[0]!) < firstText.indexOf(SUMMARY_H), `${firstText.indexOf(asks[4]!)} ${firstText.indexOf(asks[0]!)} ${firstText.indexOf(SUMMARY_H)}`)
  check('…the folded replies do not ride (the summary covers them)', !body.includes('reply 0: module 0 adjusted'))
  check('…and the carried operator turn still rides last', retry !== undefined && wireTextOf(((retry.body as { messages?: AnyMsg[] }).messages ?? []).at(-1)).endsWith(OPERATOR_ASK))
  check('the block row yields with the boundary and the summary', yields.some(y => blockOf(y) !== null) && yields.some(y => y.type === 'user' && (y as { isCompactSummary?: boolean }).isCompactSummary === true))
}

section('I wiring pins — the seams, by source')
{
  const compactSrc = readFileSync(join(ROOT, 'src/services/compact/compact.ts'), 'utf8')
  check('buildPostCompactMessages seats the block right after the boundary', /boundaryMarker,\n\s+\.\.\.\(operatorMessages !== undefined \? \[operatorMessages\] : \[\]\),\n\s+\.\.\.summaryMessages,/.test(compactSrc))
  check('the full fold selects over the folded span minus the kept tail', compactSrc.includes('selectOperatorMessages(messages, {') && compactSrc.includes('keptUuids: new Set((messagesToKeep ?? []).map(message => message.uuid))'))
  check('the partial fold selects over its summarised span', compactSrc.includes('selectOperatorMessages(summarize)'))
  check('the size guard sheds the block after every other class', /if \(estimate >= threshold && current\.operatorMessages !== undefined\) \{\n\s+shed\.push\(describeAttachment\(current\.operatorMessages\)\)/.test(compactSrc))
  const slash = readFileSync(join(ROOT, 'src/utils/processUserInput/processSlashCommand.tsx'), 'utf8')
  check('the manual /compact seats the block right after the boundary too', /compaction\.boundaryMarker,\n\s+\.\.\.\(compaction\.operatorMessages !== undefined \? \[compaction\.operatorMessages\] : \[\]\),\n\s+\.\.\.compaction\.summaryMessages,/.test(slash))
  const prompt = readFileSync(join(ROOT, 'src/services/compact/prompt.ts'), 'utf8')
  check('the summariser prompt keeps section 6 (the summary still covers every operator message)', prompt.includes('6. Operator Messages: every message the operator sent that is not a tool result.'))
  const tail = readFileSync(join(ROOT, 'src/services/compact/verbatimTail.ts'), 'utf8')
  check("the tail's rules do not move", tail.includes('export const DEFAULT_KEEP_ROUNDS = 6') && tail.includes('export const DEFAULT_TAIL_TOKEN_BUDGET = 15_000') && tail.includes('export const MIN_HEAD_ROUNDS = 2'))
}

await fixture.close()
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
