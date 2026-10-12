#!/usr/bin/env bun
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'switch-card-words-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_MODEL

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail.slice(0, 700) : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

type TransitionPlan = import('../../src/utils/model/modelTransition.ts').TransitionPlan
const { TransitionPreviewCard } = await import('../../src/components/TransitionPreviewCard.tsx')
const previewModule = (await import('../../src/services/providers/transitionPreview.ts')) as Partial<typeof import('../../src/services/providers/transitionPreview.ts')> & { transitionPlanSummary: (plan: TransitionPlan) => string }
const transitionLossRows = previewModule.transitionLossRows ?? ((): never[] => [])
const transitionPlanSummary = previewModule.transitionPlanSummary
const TRANSITION_CARRIED_WORDS = previewModule.TRANSITION_CARRIED_WORDS ?? 'text and tool results carry over unchanged'
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

const INTERNAL_WORDS = ['settlement owner', 'plan ', 'span(s)', 'round-trip', 'wire', 'continuation record', 'degrade', 'replay exactly', 'plan cap', 'regenerated', 'CURRENT truth', 'failover candidates', 'delegation']

function planOf(counts: Partial<TransitionPlan['counts']>, extra: Partial<TransitionPlan> = {}): TransitionPlan {
  return {
    v: 1,
    planDigest: 'f962466a0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    from: 'claude-sonnet-5-5',
    to: 'gpt-6-luna',
    crossProvider: true,
    targetRoute: 'openai',
    sourceRevision: '12 · uuid',
    capabilityEpoch: 'epoch',
    counts: {
      'carried-exact': 40,
      'tool-results-exact': 12,
      'thinking-continuity-reset': 0,
      'stateless-replay-reset': 0,
      'image-degraded': 0,
      'unknown-block-degraded': 0,
      ...counts,
    },
    items: [],
    itemsTruncated: false,
    needsChoice: true,
    ...extra,
  }
}

section('§1 the one owner of the loss words speaks plainly, counts in agreement, and the receipt line carries no plan id')
{
  const rows = transitionLossRows(planOf({ 'thinking-continuity-reset': 9 }), 'GPT-6 Luna')
  check('nine thinking blocks: the row says they stay behind and that the new model re-plans from the text (RED on the base: "thinking span(s) reset — reasoning never round-trips to the openai wire")', rows.length === 1 && rows[0]!.n === 9 && rows[0]!.words === 'thinking blocks stay behind — GPT-6 Luna never receives the earlier reasoning and re-plans from the text', j(rows))
  const one = transitionLossRows(planOf({ 'thinking-continuity-reset': 1, 'stateless-replay-reset': 1, 'image-degraded': 1, 'unknown-block-degraded': 1 }), 'GPT-6 Luna')
  check('singular rows read as sentences, no "(s)"', one.length === 4 && one.every(row => !row.words.includes('(s)')) && one[0]!.words.startsWith('thinking block stays behind') && one[1]!.words.startsWith('server-side thread cannot continue') && one[2]!.words.startsWith('image becomes the words "[image]"') && one[3]!.words === 'block GPT-6 Luna cannot read becomes a placeholder', j(one))
  const many = transitionLossRows(planOf({ 'stateless-replay-reset': 2, 'image-degraded': 3, 'unknown-block-degraded': 2 }), 'GPT-6 Luna')
  check('plural rows read as sentences too', many.length === 3 && many[0]!.words === 'server-side threads cannot continue — the conversation is re-sent from the transcript' && many[1]!.words === 'images become the words "[image]" — GPT-6 Luna does not take images' && many[2]!.words === 'blocks GPT-6 Luna cannot read become placeholders', j(many))
  check('a plan with no loss has no rows', transitionLossRows(planOf({}), 'GPT-6 Luna').length === 0)
  check('the label defaults to the destination model\'s own name', (transitionLossRows(planOf({ 'thinking-continuity-reset': 2 }))[0]?.words ?? '').includes('GPT-6 Luna'), j(transitionLossRows(planOf({ 'thinking-continuity-reset': 2 }))))
  const summary = transitionPlanSummary(planOf({ 'thinking-continuity-reset': 9, 'stateless-replay-reset': 2 }))
  check('the receipt line names the losses in the same words and the carried reassurance, and carries no plan id (RED on the base: "(plan f962466a)")', summary.includes('9 thinking blocks stay behind') && summary.includes('2 server-side threads cannot continue') && summary.endsWith(TRANSITION_CARRIED_WORDS) && !summary.includes('f962466a') && !summary.includes('plan '), summary)
  check('the reassurance is a plain sentence, owned by the preview module (RED on the base: absent)', previewModule.TRANSITION_CARRIED_WORDS === 'text and tool results carry over unchanged')
  const lossless = transitionPlanSummary(planOf({}, { needsChoice: false }))
  check('a plan that needs no choice keeps its empty summary', lossless === '')
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 6; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const paint = async (plan: TransitionPlan, props: { refreshed?: boolean } = {}): Promise<string[]> => {
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 120, rows: 40 }) as unknown as NodeJS.WriteStream
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const tree = React.createElement(
    StdinContext.Provider,
    { value: stdinValue as never },
    React.createElement(
      TerminalSizeContext.Provider,
      { value: { columns: 120, rows: 40 } },
      React.createElement(Box, { flexDirection: 'column', width: 120 }, React.createElement(TransitionPreviewCard, { plan, fromLabel: 'Sonnet 5.5', toLabel: 'GPT-6 Luna', refreshed: props.refreshed, onConfirm: () => {}, onCancel: () => {} })),
    ),
  )
  let painted = (): void => {}
  const firstFrame = new Promise<void>(resolve => { painted = resolve })
  const instance = await render(tree, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await firstFrame
  await settle()
  let frame = instance.lastFrame()
  for (let waited = 0; waited < 3000; waited += 25) {
    await settle()
    const next = instance.lastFrame()
    if (next === frame && stripAnsi(next).trim() !== '') break
    frame = next
  }
  const lines = stripAnsi(frame).replace(/\s+$/, '').split('\n').map(line => line.trimEnd()).filter(line => line !== '')
  instance.unmount()
  instance.cleanup()
  stream.destroy()
  return lines
}
const has = (lines: string[], text: string): boolean => lines.some(line => line.includes(text))

section('§2 the switch card as the user reads it (the Windows frame 109 shape: Sonnet 5.5 ⇄ GPT-6 Luna, nine thinking blocks)')
{
  const lines = await paint(planOf({ 'thinking-continuity-reset': 9 }, { itemsTruncated: true }), { refreshed: true })
  const text = lines.join('\n')
  check('the card paints its title and the two models', has(lines, 'Model switch preview') && has(lines, 'Sonnet 5.5 ⇄ GPT-6 Luna'), text)
  check('the loss row counts the nine blocks in plain words', has(lines, '9') && has(lines, 'thinking blocks stay behind') && has(lines, 're-plans from the text'), text)
  check('the carried reassurance is plain', has(lines, TRANSITION_CARRIED_WORDS), text)
  check('the last line says what confirm and cancel do, by model name', has(lines, 'confirm switches to GPT-6 Luna from your next message') && has(lines, 'cancel keeps Sonnet 5.5'), text)
  check('a regenerated preview says the conversation changed, in plain words', has(lines, 'the conversation changed while this preview was open'), text)
  check('a cut item list says the counts are complete', has(lines, 'the counts above are complete'), text)
  for (const word of INTERNAL_WORDS) {
    check(`no internal word on the card: "${word}" (RED on the base for plan/settlement owner/span(s)/round-trip/wire/replay exactly/plan cap/regenerated/CURRENT truth)`, !text.toLowerCase().includes(word.toLowerCase()), text)
  }
  check('no plan digest on the card', !/\b[0-9a-f]{8}\b/.test(text), text)
}

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? `  ALL PASS (${checks} checks)` : `  ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
