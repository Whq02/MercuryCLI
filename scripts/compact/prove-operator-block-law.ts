#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_HOME', 'MERCURY_COMPACT', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_SM_COMPACT']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'operator-block-law-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

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

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
const { buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { selectOperatorMessages, operatorMessagesBlockText, OPERATOR_MESSAGES_ATTACHMENT_TYPE } = await import('../../src/services/compact/operatorMessages.ts')
const { getCompactUserSummaryMessage } = await import('../../src/services/compact/prompt.ts')
const { computeVerbatimRecentTail } = await import('../../src/services/compact/verbatimTail.ts')

const BLOCK_HEADER = "The operator's own messages from the stretch folded into the summary below"
const SUMMARY_HEADER = 'The context window turned over'
const KIND: string = OPERATOR_MESSAGES_ATTACHMENT_TYPE

type AnyMsg = Record<string, unknown> & { type?: string; uuid?: string }
type Part = { type?: string; text?: unknown }
type WireItem = { role?: string; content?: unknown }
type Block = { type: string; messages: Array<{ ordinal: number; text: string }>; omitted: number }
type Fold = { result: Record<string, unknown>; block: Block | null; kept: AnyMsg[]; blockRow: AnyMsg | undefined }

const isBlockText = (text: string): boolean => text.trimStart().startsWith(BLOCK_HEADER)
const isSummaryText = (text: string): boolean => text.trimStart().startsWith(SUMMARY_HEADER)
const partsOf = (content: unknown): Part[] => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Part[]) : [])
const textsOf = (content: unknown): string[] =>
  partsOf(content)
    .map(part => part.text)
    .filter((text): text is string => typeof text === 'string' && !text.trimStart().startsWith('<system-reminder>'))
const userTextsOf = (wire: WireItem[]): string[] => wire.filter(item => item.role === 'user').flatMap(item => textsOf(item.content))
const markOf = (text: string): string => (isBlockText(text) ? '<block>' : isSummaryText(text) ? '<summary>' : text.trim().slice(0, 24))
const outsideBlock = (wire: WireItem[]): string => userTextsOf(wire).filter(text => !isBlockText(text)).join('\n')
const insideBlock = (wire: WireItem[]): string => userTextsOf(wire).filter(isBlockText).join('\n')
const timesOutside = (wire: WireItem[], line: string): number => outsideBlock(wire).split(line).length - 1
const wireOf = (messages: AnyMsg[]): WireItem[] => (normalizeMessagesForAPI(messages as never, []) as unknown as Array<{ message: WireItem }>).map(row => row.message)
const user = (text: string): AnyMsg => createUserMessage({ content: text }) as unknown as AnyMsg
const promptOf = (row: AnyMsg): string | null => (row.type === 'user' && typeof (row.message as { content?: unknown } | undefined)?.content === 'string' ? ((row.message as { content: string }).content) : null)

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

const PROMPTS = ['survey the repo', 'rename the helper', 'add the unit test', 'run the suite', 'fix the fixture typo', 'wire the helper in', 'write the changelog', 'stop and summarise'].map((words, index) => `ask ${index + 1}: ${words}`)
const NINTH = 'ask 9: carry on from the summary'
const TENTH = 'ask 10: now the docs'
const ELEVENTH = 'ask 11: and the release note'
const SUMMARY_TEXT = ['<summary>', '1. Operator Intent: the operator wants the helper renamed, tested and wired in.', '6. Operator Messages: the asks, from the survey to the summary.', '</summary>'].join('\n')

function history(): AnyMsg[] {
  const out: AnyMsg[] = []
  PROMPTS.forEach((prompt, index) => {
    out.push(user(prompt))
    out.push(assistant(`done with number ${index + 1}`))
  })
  return out
}

function foldOf(messages: AnyMsg[], keepTail: boolean): Fold {
  const tail = keepTail ? (computeVerbatimRecentTail(messages as never) as { keep: unknown[] } | null) : null
  const kept = (tail?.keep ?? []) as AnyMsg[]
  const block = selectOperatorMessages(messages as never, { keptUuids: new Set(kept.map(row => row.uuid!)) }) as Block | null
  const blockRow = block === null ? undefined : (createAttachmentMessage(block as never) as unknown as AnyMsg)
  const summary = createUserMessage({ content: getCompactUserSummaryMessage(SUMMARY_TEXT, undefined, undefined, kept.length > 0), isCompactSummary: true, isVisibleInTranscriptOnly: true })
  const result = {
    boundaryMarker: createCompactBoundaryMessage('auto', 120_000),
    operatorMessages: blockRow,
    summaryMessages: [summary],
    messagesToKeep: kept.length > 0 ? kept : undefined,
    attachments: [],
    hookResults: [],
    preCompactTokenCount: 120_000,
    postCompactTokenCount: 0,
  }
  return { result, block, kept, blockRow }
}

section('A the recogniser: a context block is known by its header and its isMeta mark, never by its words')
{
  const one: Block = { type: KIND, messages: [{ ordinal: 1, text: PROMPTS[0]! }], omitted: 0 }
  const other: Block = { type: KIND, messages: [{ ordinal: 2, text: 'entirely different words' }, { ordinal: 1, text: 'and more of them' }], omitted: 0 }
  const rows = normalizeAttachmentForAPI(one as never) as Array<{ isMeta?: boolean; message: { content: unknown } }>
  const text = rows.length === 1 ? textsOf(rows[0]!.message.content).join('\n') : ''
  check('the block projects to ONE meta user row', rows.length === 1 && rows[0]!.isMeta === true, j(rows).slice(0, 160))
  check("…headed by the header the wire scans know it by (the product's own words)", isBlockText(text) && operatorMessagesBlockText(one as never).startsWith(BLOCK_HEADER) && operatorMessagesBlockText(other as never).startsWith(BLOCK_HEADER), text.slice(0, 120))
  check('the header stands whatever the entries say; an operator row carrying the same words is no block', isBlockText(operatorMessagesBlockText(other as never)) && text.includes(PROMPTS[0]!) && !isBlockText(PROMPTS[0]!))
  check('the summary row opens with the words the scans know it by, and is no block', isSummaryText(getCompactUserSummaryMessage(SUMMARY_TEXT)) && !isBlockText(getCompactUserSummaryMessage(SUMMARY_TEXT)))
}

section('B the assembly: boundary, block, summary, then the kept tail whole')
{
  const { result, block, kept } = foldOf(history(), true)
  const post = buildPostCompactMessages(result as never) as unknown as AnyMsg[]
  const blockAt = post.findIndex(row => row.type === 'attachment' && (row.attachment as { type?: string } | undefined)?.type === KIND)
  const summaryAt = post.findIndex(row => (row as { isCompactSummary?: boolean }).isCompactSummary === true)
  check('the tail kept the last rounds and a block was built', kept.length > 0 && block !== null, `kept=${kept.length} block=${j(block)}`)
  check('the block sits right after the boundary and before the summary', post[0]?.type === 'system' && blockAt === 1 && summaryAt === 2, j(post.map(row => row.type)))
  check('the kept rows follow the summary, whole and in order', post.length === 3 + kept.length && kept.every((row, index) => post[3 + index]?.uuid === row.uuid), j(post.map(row => row.type)))
}

section('C the next request, an ask following: the block once, ahead of the summary, never last; no line twice outside it')
{
  const { result, kept } = foldOf(history(), true)
  const post = buildPostCompactMessages(result as never) as unknown as AnyMsg[]
  const wire = wireOf([...post, user(NINTH)])
  const texts = userTextsOf(wire)
  console.log(`  │ user text parts on the wire: ${j(texts.map(markOf))}`)
  check('exactly one text part is the block', texts.filter(isBlockText).length === 1, j(texts.map(markOf)))
  const head = textsOf(wire[0]?.content)
  check('the block precedes the summary inside the first user turn', wire[0]?.role === 'user' && head.findIndex(isBlockText) >= 0 && head.findIndex(isBlockText) < head.findIndex(isSummaryText), j(head.map(markOf)))
  check('the last user text is the ask that followed — not the block, not the summary', wire.at(-1)?.role === 'user' && (texts.at(-1) ?? '').trim() === NINTH, j(texts.at(-1)))
  const keptPrompts = PROMPTS.filter(prompt => kept.some(row => promptOf(row) === prompt))
  const foldedPrompts = PROMPTS.filter(prompt => !keptPrompts.includes(prompt))
  check('the tail keeps some asks and the fold takes the rest', keptPrompts.length > 0 && foldedPrompts.length > 0, `kept=${keptPrompts.length} folded=${foldedPrompts.length}`)
  const inside = insideBlock(wire)
  check('a folded ask rides inside the block and nowhere else', foldedPrompts.every(prompt => inside.includes(prompt) && timesOutside(wire, prompt) === 0), j(foldedPrompts.map(prompt => [prompt.slice(0, 6), timesOutside(wire, prompt)])))
  check('a kept ask rides once outside the block and never inside it', keptPrompts.every(prompt => timesOutside(wire, prompt) === 1 && !inside.includes(prompt)), j(keptPrompts.map(prompt => [prompt.slice(0, 6), timesOutside(wire, prompt)])))
  check('no line rides twice outside the block, the new ask included', [...PROMPTS, NINTH].every(prompt => timesOutside(wire, prompt) <= 1) && timesOutside(wire, NINTH) === 1)
}

section('D a second fold: the first block folds into the second, one block on the wire, still nothing twice outside it')
{
  const first = foldOf(history(), true)
  const afterFirst = [...(buildPostCompactMessages(first.result as never) as unknown as AnyMsg[]), user(NINTH), assistant('done with number nine'), user(TENTH), assistant('done with number ten')]
  const second = foldOf(afterFirst, true)
  const post = buildPostCompactMessages(second.result as never) as unknown as AnyMsg[]
  const wire = wireOf([...post, user(ELEVENTH)])
  const texts = userTextsOf(wire)
  console.log(`  │ user text parts on the wire: ${j(texts.map(markOf))}`)
  const asksSoFar = [...PROMPTS, NINTH, TENTH]
  const keptAsks = asksSoFar.filter(ask => second.kept.some(row => promptOf(row) === ask))
  const foldedAsks = asksSoFar.filter(ask => !keptAsks.includes(ask))
  check('the second fold kept a tail and folded the rest, the first block among the folded rows', second.kept.length > 0 && foldedAsks.length > 0 && !second.kept.some(row => row.uuid === first.blockRow?.uuid), `kept=${keptAsks.length} folded=${foldedAsks.length}`)
  check("the second block carries the first block's entries forward with the folded asks since, once each", second.block !== null && foldedAsks.every(ask => second.block!.messages.filter(entry => entry.text === ask).length === 1) && keptAsks.every(ask => !second.block!.messages.some(entry => entry.text === ask)), j(second.block?.messages.map(entry => entry.text.slice(0, 6))))
  check('one block on the wire — the first block row is folded, not repeated', texts.filter(isBlockText).length === 1 && !post.some(row => row.uuid === first.blockRow?.uuid), j(texts.map(markOf)))
  check('the block precedes the summary, and the new ask rides last', texts.findIndex(isBlockText) >= 0 && texts.findIndex(isBlockText) < texts.findIndex(isSummaryText) && (texts.at(-1) ?? '').trim() === ELEVENTH, j(texts.map(markOf)))
  check('nothing twice outside the block: the folded asks ride only inside it, the kept ones once', foldedAsks.every(ask => timesOutside(wire, ask) === 0) && keptAsks.every(ask => timesOutside(wire, ask) === 1) && timesOutside(wire, ELEVENTH) === 1, j(asksSoFar.map(ask => [ask.slice(0, 6), timesOutside(wire, ask)])))
}

section('E no ask following (a fold inside a running turn): the block is never the last user text')
{
  const bare = foldOf(history(), false)
  const bareWire = wireOf(buildPostCompactMessages(bare.result as never) as unknown as AnyMsg[])
  const bareTexts = userTextsOf(bareWire)
  console.log(`  │ keep-tail off: ${j(bareTexts.map(markOf))}`)
  check('keep-tail off: one user turn, the block then the summary — the summary is the last text', bareWire.length === 1 && bareWire[0]?.role === 'user' && bareTexts.length === 2 && isBlockText(bareTexts[0]!) && isSummaryText(bareTexts[1]!), j(bareTexts.map(markOf)))
  const kept = foldOf(history(), true)
  const keptWire = wireOf(buildPostCompactMessages(kept.result as never) as unknown as AnyMsg[])
  const keptTexts = userTextsOf(keptWire)
  console.log(`  │ keep-tail on:  ${j(keptTexts.map(markOf))}`)
  check('keep-tail on: the block leads, the summary follows it, and the last user text is a kept operator row', keptTexts.findIndex(isBlockText) === 0 && keptTexts.findIndex(isSummaryText) === 1 && keptTexts.length > 2 && !isBlockText(keptTexts.at(-1)!) && PROMPTS.includes((keptTexts.at(-1) ?? '').trim()), j(keptTexts.map(markOf)))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
