#!/usr/bin/env bun

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.FORCE_COLOR = '3'
const HOME = mkdtempSync(join(tmpdir(), 'thinking-withheld-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
for (const name of ['GOOGLE_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET']) delete process.env[name]
process.env.GEMINI_API_KEY = 'AIzaFixtureWithheldRow000000000000000000'
writeFileSync(join(HOME, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'api-key' }))
delete process.env.MERCURY_MODEL
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

let checks = 0
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  ${cond ? '✓' : '✗'} ${label}${cond ? '' : ' — ' + detail.slice(0, 600)}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n── ${title}`)
const j = (v: unknown): string => JSON.stringify(v)
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const mounted = (node: unknown): ReturnType<typeof React.createElement> =>
  React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() } as never, node as never)
const thinkingModule = (await import('../../src/components/messages/AssistantThinkingMessage.tsx')) as typeof import('../../src/components/messages/AssistantThinkingMessage.tsx') & { thinkingTextWithheld?: (param: { thinking?: string; signature?: string }) => boolean }
const { AssistantThinkingMessage } = thinkingModule
const grammar = (await import('../../src/components/messages/thinkingGrammar.tsx')) as typeof import('../../src/components/messages/thinkingGrammar.tsx') & { WITHHELD_THINKING_WORDS?: string }

const paint = async (param: { type: string; thinking: string; signature?: string }, props: Record<string, unknown> = {}): Promise<string> =>
  stripAnsi(await renderToAnsiString(mounted(React.createElement(AssistantThinkingMessage, { param, ...props } as never)), 100)).trim()

section('Private thinking is silent by default and disclosed on demand')
{
  const SIGNATURE = 'CAQSQEJBQlaYmNjb5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0A='
  check('the grammar owns the withheld words, plainly (RED on the base: absent)', grammar.WITHHELD_THINKING_WORDS === 'the provider returned no thinking text for this model', j(grammar.WITHHELD_THINKING_WORDS))
  check('the withheld test: empty text with a signature is withheld; empty text with no signature (still streaming) is not; text is not', thinkingModule.thinkingTextWithheld !== undefined && thinkingModule.thinkingTextWithheld({ thinking: '', signature: SIGNATURE }) === true && thinkingModule.thinkingTextWithheld({ thinking: '', signature: '' }) === false && thinkingModule.thinkingTextWithheld({ thinking: 'words', signature: SIGNATURE }) === false)
  const withheld = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE })
  check('the settled empty block paints no row by default', withheld === '', j(withheld))
  const clicked = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE }, { verbose: true })
  check('click expansion shows the fact once without a disclosure cue', clicked.startsWith(grammar.THINKING_LABEL) && clicked.includes(grammar.WITHHELD_THINKING_WORDS!) && clicked.split('\n').length === 1 && !/to expand|⌄/.test(clicked), j(clicked))
  const transcript = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE }, { isTranscriptMode: true })
  check('the transcript view (ctrl+o) paints the same fact row', transcript.includes('the provider returned no thinking text for this model'), j(transcript))
  const streaming = await paint({ type: 'thinking', thinking: '', signature: '' })
  check('a block still streaming (no signature yet) paints nothing — the fact is never flashed early', streaming === '', j(streaming))
  const hidden = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE }, { isTranscriptMode: true, hideInTranscript: true })
  check('a transcript row hidden behind the last reasoning block stays hidden', hidden === '', j(hidden))
  const withText = await paint({ type: 'thinking', thinking: 'the reasoning body', signature: SIGNATURE })
  check('a block with text keeps its fold cue and shows no fact (unchanged)', withText.startsWith(grammar.THINKING_LABEL) && /to expand|⌄/.test(withText) && !withText.includes('returned no thinking text'), j(withText))
  const withheldAnsi = await renderToAnsiString(mounted(React.createElement(AssistantThinkingMessage, { param: { type: 'thinking', thinking: '', signature: SIGNATURE }, isTranscriptMode: true } as never)), 100)
  check('the fact row paints in the thinking grammar (italic, one run)', withheldAnsi.includes('\x1b[3m'), j(withheldAnsi.slice(0, 80)))
}

section('The Gemini shape (F35A-11): a signed reasoning part with no text reaches the transcript as the same settled empty block')
{
  const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
  const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { withheldThinkingDisclosure } = await import('../../src/components/messages/withheldThinkingDisclosure.ts')
  const { z } = await import('zod')
  type Assistant = import('../../src/types/message.ts').AssistantMessage & { geminiProviderTurn?: { parts: unknown[]; projection: string } }
  const model = 'gemini-3.8-flash'
  const read = { name: 'Read', prompt: async () => 'Reads a file.', inputSchema: z.object({ path: z.string() }), inputJSONSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
  const sse = (chunks: unknown[]): Response => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  const realFetch = globalThis.fetch
  let wire: unknown[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    if (!url.startsWith('https://gemini.fixture.invalid/')) throw new Error('unpinned request')
    return sse(wire)
  }) as typeof fetch
  const drain = async (chunks: unknown[], withTool = false): Promise<Assistant[]> => {
    wire = chunks
    const out: Assistant[] = []
    const params = {
      messages: [{ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: 'Turn 1: in one short sentence, what does app.py print?' } }],
      systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: withTool ? [read] : [], signal: new AbortController().signal,
      options: { model, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 },
    }
    for await (const item of geminiCallModel(params as never)) if (item.type === 'assistant') out.push(item as Assistant)
    return out
  }
  const usage = { promptTokenCount: 40, candidatesTokenCount: 9, thoughtsTokenCount: 120 }
  const blocksOf = (rows: Assistant[]) => rows.flatMap(row => row.message.content)
  try {
    const air = await drain([
      { candidates: [{ content: { role: 'model', parts: [{ thought: true, thoughtSignature: 'sig-air-1' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'app.py prints apples and plums on separate lines.' }] }, finishReason: 'STOP' }], usageMetadata: usage },
    ])
    const first = blocksOf(air)[0] as { type: string; thinking?: string; signature?: string } | undefined
    check('the Air\'s turn: the signed empty reasoning part settles as a thinking block before the answer, signed and empty (RED on the base: the turn holds the answer text only)', first?.type === 'thinking' && first.thinking === '' && first.signature === 'sig-air-1' && blocksOf(air).length === 2 && blocksOf(air)[1]?.type === 'text', j(blocksOf(air)))
    check('the block is the withheld shape the component already knows', first !== undefined && thinkingModule.thinkingTextWithheld!(first) === true)
    const transcript = await paint({ type: 'thinking', thinking: first?.thinking ?? 'absent', signature: first?.signature ?? '' }, { isTranscriptMode: true })
    check('the transcript view (ctrl+o) paints the fact for the Gemini turn', transcript.includes(grammar.WITHHELD_THINKING_WORDS!), j(transcript))
    check('the chat paints no row for it by default', (await paint({ type: 'thinking', thinking: first?.thinking ?? 'absent', signature: first?.signature ?? '' })) === '')
    const disclosure = withheldThinkingDisclosure(air as never)
    check('a click of the answer discloses it: the fact rides the answer row and the thinking row stays hidden', disclosure.hidden.has(air[0]!.uuid) && disclosure.byRow.get(air[1]!.uuid)?.signature === 'sig-air-1', j([...disclosure.byRow.keys()]))
    const record = air.at(-1)?.geminiProviderTurn
    check('the replay record keeps Google\'s own parts (the signed empty thought part, then the text) and its projection carries no thinking block', JSON.stringify(record?.parts) === JSON.stringify([{ text: '', thought: true, thoughtSignature: 'sig-air-1' }, { text: 'app.py prints apples and plums on separate lines.' }]) && typeof record?.projection === 'string' && !record.projection.includes('thinking'), j(record))

    const signedText = await drain([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'pears', thoughtSignature: 'sig-air-2' }] }, finishReason: 'STOP' }], usageMetadata: usage },
    ])
    check('a signature riding the answer text with no thought text: the same block, once, before the text', JSON.stringify(blocksOf(signedText).map(block => [block.type, (block as { signature?: string }).signature])) === JSON.stringify([['thinking', 'sig-air-2'], ['text', undefined]]), j(blocksOf(signedText)))

    const twoSignatures = await drain([
      { candidates: [{ content: { role: 'model', parts: [{ text: '12', thoughtSignature: 'sig-air-3' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ thoughtSignature: 'sig-air-3b' }] }, finishReason: 'STOP' }], usageMetadata: usage },
    ])
    check('two signatures in one turn mint one fact, never two', blocksOf(twoSignatures).filter(block => block.type === 'thinking').length === 1, j(blocksOf(twoSignatures)))

    const toolTurn = await drain([
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'Read', args: { path: '/proj/app.py' } }, thoughtSignature: 'sig-air-4' }] }, finishReason: 'STOP' }], usageMetadata: usage },
    ], true)
    check('a signed function call with no thought text: the fact block, then the tool call', JSON.stringify(blocksOf(toolTurn).map(block => block.type)) === JSON.stringify(['thinking', 'tool_use']) && (blocksOf(toolTurn)[0] as { signature?: string }).signature === 'sig-air-4', j(blocksOf(toolTurn)))

    const returned = await drain([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Reading the file first.', thought: true }, { text: 'apples', thoughtSignature: 'sig-air-5' }] }, finishReason: 'STOP' }], usageMetadata: usage },
    ])
    const returnedBlocks = blocksOf(returned) as Array<{ type: string; thinking?: string }>
    check('thinking text the provider did return keeps its own block and body; no withheld fact is minted beside it (unchanged)', returnedBlocks.filter(block => block.type === 'thinking').length === 1 && returnedBlocks[0]?.thinking === 'Reading the file first.' && returnedBlocks[1]?.type === 'text', j(returnedBlocks))

    const faulted = await drain([
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'Read', args: { path: '/a' } }, thoughtSignature: 'sig-air-6' }, { functionCall: { id: 'call-1', name: 'Read', args: { path: '/b' } } }] }, finishReason: 'STOP' }], usageMetadata: usage },
    ], true)
    check('a stream that faults after a signed call mints no fact: the fault road is unchanged (one typed error row, nothing settled)', !faulted.some(row => row.message.content.some(block => block.type === 'thinking' || block.type === 'tool_use')) && faulted.some(row => (row as { isApiErrorMessage?: boolean }).isApiErrorMessage === true), j(faulted.map(row => row.message.content)))
  } finally {
    globalThis.fetch = realFetch
  }
}

section('THK-06 — an effort receipt the one-line status row would cut goes to the chat whole')
{
  const bar = (await import('../../src/components/SwitchboardTagBar.tsx')) as typeof import('../../src/components/SwitchboardTagBar.tsx') & { statusRowReceiptFits?: (text: string, fit: unknown) => boolean }
  const fits = bar.statusRowReceiptFits
  check('the status row owns a fit check for a receipt (RED on the base: absent)', typeof fits === 'function')
  const frame037 = { columns: 177, head: 'Haiku 4.5', samples: [], folder: 'hunt-thinking', branch: null, backHint: '⇧← back' }
  const long = 'claude-haiku-4-5-20251001 takes no effort setting — max was kept for this session\'s next effort-capable model. Saved as your default for future sessions.'
  check('the frame-037 receipt does not fit a 177-column row (it was cut to "takes no…")', fits?.(long, frame037) === false)
  check('a short receipt fits the same row', fits?.('Effort set to max for this session — its next request runs it.', frame037) === true)
  check('a receipt that fits at 177 columns is cut at 100', fits?.('Effort set to max for this session — its next request runs it. Saved as your default for future sessions.', { ...frame037, columns: 100 }) === false)
  check('with no row painted yet the check does not refuse', fits?.(long, null) === true)
  const plan = bar.statusRowPlan({ ...frame037, rest: long })
  check('the plan the row would paint for that receipt is indeed the cut tail (the field frame)', plan.rest !== long && plan.rest.startsWith('…') === false && plan.rest.includes(' — max was kept'), j(plan.rest))

  const effort = readFileSync(join(ROOT, 'src/commands/effort/effort.tsx'), 'utf8')
  check('the effort command paints a receipt the row refuses as chat rows (the echoed command and its text), never a cut line (RED on the base: the status row or a one-line notification only)', effort.includes('function receiptInChat(') && effort.includes("formatCommandLoadingMetadata('effort', args)") && effort.includes('receiptOnStatusRow(receipt) || receiptInChat(receipt, args)'), '')
  check('the slider road takes the same door', effort.includes("receiptOnStatusRow(receipt) || receiptInChat(receipt, String(value))"))
  const painter = readFileSync(join(ROOT, 'src/components/SwitchboardTagBar.tsx'), 'utf8')
  check('the status row refuses a receipt it would cut', /paintStatusRowReceipt\(text: string\): boolean \{\n  if \(rowsPainting === 0 \|\| text\.trim\(\) === '' \|\| !statusRowReceiptFits\(text\)\) return false/.test(painter))
  check('the no-effort receipt names the model by its display name and says where the level goes, shortly', effort.includes('${renderModelName(model)} takes no effort setting — ${level} is kept for the next model that takes one.${saved}'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
