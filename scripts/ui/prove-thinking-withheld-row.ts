#!/usr/bin/env bun
// gate-watch: src/components/messages/AssistantThinkingMessage.tsx src/components/messages/thinkingGrammar.tsx
// gate-watch: src/components/SwitchboardTagBar.tsx src/commands/effort/effort.tsx
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.FORCE_COLOR = '3'
const HOME = mkdtempSync(join(tmpdir(), 'thinking-withheld-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_MODEL
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

section('THK-05 — a thinking block the provider returned signed but without text paints a row that says so (nine of twelve Claude models)')
{
  const SIGNATURE = 'CAQSQEJBQlaYmNjb5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0A='
  check('the grammar owns the withheld words, plainly (RED on the base: absent)', grammar.WITHHELD_THINKING_WORDS === 'the provider returned no thinking text for this model', j(grammar.WITHHELD_THINKING_WORDS))
  check('the withheld test: empty text with a signature is withheld; empty text with no signature (still streaming) is not; text is not', thinkingModule.thinkingTextWithheld !== undefined && thinkingModule.thinkingTextWithheld({ thinking: '', signature: SIGNATURE }) === true && thinkingModule.thinkingTextWithheld({ thinking: '', signature: '' }) === false && thinkingModule.thinkingTextWithheld({ thinking: 'words', signature: SIGNATURE }) === false)
  const withheld = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE })
  check('the settled empty block paints the thinking label and the fact, on one row (RED on the base: nothing at all)', withheld.startsWith(grammar.THINKING_LABEL) && withheld.includes('the provider returned no thinking text for this model') && withheld.split('\n').length === 1, j(withheld))
  check('…with no disclosure cue (there is nothing to open)', !/to expand|⌄/.test(withheld), j(withheld))
  const transcript = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE }, { isTranscriptMode: true })
  check('the transcript view (ctrl+o) paints the same fact row', transcript.includes('the provider returned no thinking text for this model'), j(transcript))
  const streaming = await paint({ type: 'thinking', thinking: '', signature: '' })
  check('a block still streaming (no signature yet) paints nothing — the fact is never flashed early', streaming === '', j(streaming))
  const hidden = await paint({ type: 'thinking', thinking: '', signature: SIGNATURE }, { isTranscriptMode: true, hideInTranscript: true })
  check('a transcript row hidden behind the last reasoning block stays hidden', hidden === '', j(hidden))
  const withText = await paint({ type: 'thinking', thinking: 'the reasoning body', signature: SIGNATURE })
  check('a block with text keeps its fold cue and shows no fact (unchanged)', withText.startsWith(grammar.THINKING_LABEL) && /to expand|⌄/.test(withText) && !withText.includes('returned no thinking text'), j(withText))
  const withheldAnsi = await renderToAnsiString(mounted(React.createElement(AssistantThinkingMessage, { param: { type: 'thinking', thinking: '', signature: SIGNATURE } } as never)), 100)
  check('the fact row paints in the thinking grammar (italic, one run)', withheldAnsi.includes('\x1b[3m'), j(withheldAnsi.slice(0, 80)))
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
