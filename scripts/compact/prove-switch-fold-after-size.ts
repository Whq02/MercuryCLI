#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'GOOGLE_API_KEY', 'MERCURY_COMPACT',
  'MERCURY_AUTO_COMPACT', 'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_AUTOCOMPACT_PCT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_MAX_OUTPUT_TOKENS',
  'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_SM_COMPACT', 'MERCURY_CONCOURSE_WORKER',
]) {
  delete process.env[ambient]
}
const scratch = mkdtempSync(join(tmpdir(), 'switch-fold-after-size-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string, change: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? '' : ` — ${detail} — change: ${change}`}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — prove-switch-fold-after-size exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { startOverflowFixture } = await import('./overflowFixture.ts')
const fixture = await startOverflowFixture()
Object.assign(process.env, fixture.env)

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { contextFill } = await import('../../src/engine/context-window/contextTokenCount.ts')
const { contextFillView } = await import('../../src/engine/context-window/contextFill.ts')
const { primeOpenaiCatalogue } = await import('../../src/models/roads/openai/openaiCatalogue.ts')
const { requestGaugeDigest } = await import('../../src/engine/run/requestGauge.ts')
const { buildPostFoldMessages } = await import('../../src/engine/compaction/foldConversation.ts')
const { estimateContextTokens } = await import('../../src/engine/compaction/pruneToolResults.ts')
const { call } = await import('../../src/commands/compact/compact.ts')

const SOURCE = 'claude-opus-4-8'
const SEATED = 'gpt-5.6-sol'
const WINDOW = 65_536
const FIXED = 31_900
const NOTES = 6
const METER = 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must state the after size of a fold on the seated model\'s own count when the context before it was measured by a model of another family; compactConversation in src/engine/compaction/foldConversation.ts records that figure'
const GAUGE = 'messageContextFill in src/engine/context-window/messageContextFill.ts must estimate only the rows that stand after the last fold boundary'

if (!primeOpenaiCatalogue({
  sourceKind: 'api-key',
  models: [{ id: SEATED, displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'high'], reasoningEffortsStated: true, defaultReasoningEffort: 'low', visibility: 'list', supportedInApi: true, priority: 1, contextWindow: WINDOW, inputModalities: ['text', 'image'] }],
  fetchedAtMs: Date.now() + 1,
})) throw new Error('the catalogue prime was refused')

type AnyMsg = Record<string, unknown> & { type?: string }
type Folded = { type: string; displayText?: string; compactionResult: Parameters<typeof buildPostFoldMessages>[0] }

function makeContext(model: string, messages: AnyMsg[]): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: { commands: [], tools: [], engineModel: model, thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, debug: false, verbose: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    getAppState: () => appState,
    setAppState: (update: (prev: never) => never): void => {
      appState = update(appState as never) as unknown as Record<string, unknown>
    },
    messages,
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

function noteText(n: number): string {
  let out = ''
  for (let line = 0; out.length < 40_000; line++) out += `Note ${n}, section ${line} records a module boundary: ${(n * 7919 + line * 104729).toString(16).padStart(64, 'a')}. Check the indexed observations before changing it.\n`
  return out
}

function sixNotesMeasuredBy(model: string): AnyMsg[] {
  const rows: AnyMsg[] = []
  let sent = FIXED
  for (let n = 1; n <= NOTES; n++) {
    rows.push(createUserMessage({ content: `write design note ${n}` }) as AnyMsg)
    const text = noteText(n)
    const digest = requestGaugeDigest(rows as never)
    sent += 6
    rows.push({
      type: 'assistant',
      uuid: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`,
      timestamp: new Date().toISOString(),
      requestId: `req_${n}`,
      message: { id: `msg_${n}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: sent, output_tokens: Math.round(text.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      contextGauge: { version: 1, key: `anthropic:${model}:c1`, epoch: 1, digest, rawTokens: sent - FIXED, fixed: { digest: 'f', tokens: FIXED }, density: { ratio: 1, samples: 0, residuals: [] }, sample: { eligible: false, denominator: 0, measured: 0, reason: 'cold' } },
    })
    sent += Math.round(text.length / 4)
  }
  return rows
}

async function fold(seated: string): Promise<{ messages: AnyMsg[]; folded: Folded | undefined; threw: string }> {
  fixture.script([{ text: 'SUMMARY BY OPUS: the design notes were written one by one and the operator asked to carry on from them.' }, { text: 'never reached' }])
  const messages = sixNotesMeasuredBy(SOURCE)
  try {
    return { messages, folded: (await call('', makeContext(seated, messages) as never)) as Folded, threw: '' }
  } catch (error) {
    return { messages, folded: undefined, threw: error instanceof Error ? error.message : String(error) }
  }
}
const receiptOf = (folded: Folded | undefined): string => (folded?.displayText ?? '').replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0] ?? ''

section('1 a fold that serves a switch: six notes measured by one model, the session now seated on a model of another family')
{
  const { messages, folded, threw } = await fold(SEATED)
  const before = contextFill(messages as never).tokens
  const result = folded?.compactionResult
  const post = result === undefined ? [] : (buildPostFoldMessages(result) as AnyMsg[])
  const seatedCount = contextFill(post as never, SEATED).tokens
  const recorded = result?.boundaryMarker.compactMetadata.postTokens
  check('the fold lands', folded?.type === 'compact', threw, METER)
  check('the outgoing model measured more than the incoming model will carry: the before figure holds its own fixed material', before > estimateContextTokens(messages as never, SEATED) + FIXED / 2, `${before} against ${estimateContextTokens(messages as never, SEATED)}`, 'the fixture of this proof: sixNotesMeasuredBy must stamp usage that includes the fixed material')
  check("the after size on the fold's record is the seated model's own count of what stands after it", recorded !== undefined && recorded === seatedCount && result?.truePostCompactTokenCount === seatedCount, JSON.stringify({ recorded, result: result?.truePostCompactTokenCount, seatedCount, before }), METER)
  check(`it lands under half the seated window of ${WINDOW.toLocaleString('en-US')}`, recorded !== undefined && recorded < WINDOW / 2, String(recorded), METER)
  check('the receipt prints that figure', /^Compacted — folded \d+ messages into the summary · context 92k → 20\.\dk tokens/.test(receiptOf(folded)), receiptOf(folded), METER)
  const stored = [...messages, ...post]
  check('the gauge of the stored conversation reads the same figure for the seated model: the folded rows are not counted again', contextFill(stored as never, SEATED).tokens === recorded && contextFillView(stored as never, SEATED).usedTokens === recorded, JSON.stringify({ gauge: contextFill(stored as never, SEATED), view: contextFillView(stored as never, SEATED).usedTokens, recorded }), GAUGE)
}

section('2 no switch: the same six notes folded on the model that measured them')
{
  const { messages, folded, threw } = await fold(SOURCE)
  const result = folded?.compactionResult
  const post = result === undefined ? [] : (buildPostFoldMessages(result) as AnyMsg[])
  const before = contextFill(messages as never).tokens
  const saved = estimateContextTokens(messages as never, SOURCE) - estimateContextTokens(post as never, SOURCE)
  check('the fold lands', folded?.type === 'compact', threw, METER)
  check('the after size is the measured before figure less what the fold saved by the one estimate, as it was', saved > 0 && result?.truePostCompactTokenCount === before - saved && result.boundaryMarker.compactMetadata.postTokens === before - saved, JSON.stringify({ before, saved, result: result?.truePostCompactTokenCount, recorded: result?.boundaryMarker.compactMetadata.postTokens }), 'createFoldMeter in src/engine/compaction/fold/foldMeasure.ts must keep contextAfterFold for a conversation the seated model measured')
}

await fixture.close()
clearTimeout(guard)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
