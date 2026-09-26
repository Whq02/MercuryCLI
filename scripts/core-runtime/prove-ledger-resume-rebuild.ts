#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ledger-resume-home-'))
const STORE = mkdtempSync(join(tmpdir(), 'ledger-resume-store-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_TRANSCRIPT_READER
delete process.env.MERCURY_RESUME_SNAPSHOT

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9
const money = (n: number): string => `$${n.toFixed(6)}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const state = await import('../../src/bootstrap/state.ts')
state.setIsInteractive(false)
const tracker = await import('../../src/cost-tracker.ts')
const { saveCurrentProjectConfig, getCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { calculateUSDCost } = await import('../../src/utils/modelCost.ts')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { SYNTHETIC_MODEL } = await import('../../src/utils/messages/factories.ts')

const FABLE = 'claude-fable-5-1'
const SONNET = 'claude-sonnet-5'
type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
type Row = { uuid: string; model: string; usage: Usage }
let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
let clock = Date.parse('2026-01-01T00:00:00.000Z')
const base = (sid: string, uuid: string, parent: string | null): Record<string, unknown> => ({
  uuid,
  parentUuid: parent,
  isSidechain: false,
  cwd: STORE,
  sessionId: sid,
  version: '1.0.0',
  timestamp: new Date((clock += 1000)).toISOString(),
})
const userRow = (sid: string, uuid: string, parent: string | null, text: string): Record<string, unknown> => ({
  ...base(sid, uuid, parent),
  type: 'user',
  message: { role: 'user', content: text },
})
const assistantRow = (sid: string, uuid: string, parent: string | null, model: string, usage: Usage, id?: string): Record<string, unknown> => ({
  ...base(sid, uuid, parent),
  type: 'assistant',
  message: {
    id: id ?? `msg_${uuid.slice(-6)}`,
    role: 'assistant',
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: `reply ${uuid.slice(-4)}` }],
    usage,
  },
})
const append = (file: string, entry: Record<string, unknown>): void => {
  appendFileSync(file, encodeTranscriptLine(file, entry).line)
}
const exchange = (file: string, sid: string, parent: string | null, model: string, usage: Usage): Row => {
  const u = uid()
  append(file, userRow(sid, u, parent, `ask ${u.slice(-4)}`))
  const a = uid()
  append(file, assistantRow(sid, a, u, model, usage))
  return { uuid: a, model, usage }
}
type Expected = { total: number; byModel: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> }
function expectedOf(rows: Array<{ model: string; usage: Usage }>): Expected {
  const out: Expected = { total: 0, byModel: {} }
  for (const row of rows) {
    const cost = calculateUSDCost(row.model, row.usage)
    const record = out.byModel[row.model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 }
    record.inputTokens += row.usage.input_tokens
    record.outputTokens += row.usage.output_tokens
    record.cacheReadInputTokens += row.usage.cache_read_input_tokens
    record.cacheCreationInputTokens += row.usage.cache_creation_input_tokens
    record.costUSD += cost
    out.byModel[row.model] = record
    out.total += cost
  }
  return out
}
function ledgerMatches(expected: Expected): { ok: boolean; detail: string } {
  const usage = tracker.getModelUsage()
  const models = Object.keys(expected.byModel).sort()
  const detail = `ledger total ${money(tracker.getTotalCost())} models ${JSON.stringify(usage)} · expected total ${money(expected.total)} models ${JSON.stringify(expected.byModel)}`
  if (!near(tracker.getTotalCost(), expected.total)) return { ok: false, detail }
  if (Object.keys(usage).sort().join(',') !== models.join(',')) return { ok: false, detail }
  for (const model of models) {
    const got = usage[model]!
    const want = expected.byModel[model]!
    if (got.inputTokens !== want.inputTokens || got.outputTokens !== want.outputTokens || got.cacheReadInputTokens !== want.cacheReadInputTokens || got.cacheCreationInputTokens !== want.cacheCreationInputTokens || !near(got.costUSD, want.costUSD)) {
      return { ok: false, detail }
    }
  }
  return { ok: true, detail }
}
const plain = (s: string): string => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
const OTHER = '00000000-aaaa-4000-8000-00000000000f'
const slotForOther = (): void => {
  saveCurrentProjectConfig(config => ({
    ...config,
    lastSessionId: OTHER,
    lastCost: 9.99,
    lastAPIDuration: 4242,
    lastAPIDurationWithoutRetries: 4200,
    lastLinesAdded: 77,
    lastLinesRemoved: 7,
    lastModelUsage: { [SONNET]: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 9.99 } },
    lastUnpricedTurns: {},
  }))
}
async function resume(sid: string): Promise<boolean> {
  state.switchSession(sid as never, STORE)
  tracker.resetCostState()
  return await tracker.restoreCostStateForSession(sid)
}

console.log('============================================================')
console.log(' the session ledger on resume: the raw records, not the slot')
console.log('============================================================')

section('§1 a session the project slot never saw resumes to its true spend, summed from the raw records through the price owner')
const SID1 = '00000000-aaaa-4000-8000-000000000001'
{
  const file = join(STORE, `${SID1}.jsonl`)
  writeFileSync(file, '')
  const r1 = exchange(file, SID1, null, FABLE, { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 8000, cache_creation_input_tokens: 500 })
  const r2 = exchange(file, SID1, r1.uuid, SONNET, { input_tokens: 700, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 })
  const r3 = exchange(file, SID1, r2.uuid, FABLE, { input_tokens: 50, output_tokens: 1500, cache_read_input_tokens: 9700, cache_creation_input_tokens: 0 })
  const expected = expectedOf([r1, r2, r3])
  check('the fixture prices: both models carry a recorded rate', expected.total > 0 && expected.byModel[FABLE]!.costUSD > 0 && expected.byModel[SONNET]!.costUSD > 0, money(expected.total))
  slotForOther()
  check('the control: the project slot names ANOTHER session', getCurrentProjectConfig().lastSessionId === OTHER)
  const restored = await resume(SID1)
  const verdict = ledgerMatches(expected)
  check('RED ON THE BASE: the resume restored a ledger for the foreign session', restored === true, 'restoreCostStateForSession returned false — the slot names another session, so the base restores nothing')
  check(`RED ON THE BASE: the foreign session's ledger is the transcript's sum per model (${money(expected.total)}), not zero`, verdict.ok, verdict.detail)
  check("the other session's slot figures never reach this ledger", !near(tracker.getTotalCost(), 9.99) && tracker.getTotalAPIDuration() === 0 && tracker.getTotalLinesAdded() === 0, `total ${money(tracker.getTotalCost())} api ${tracker.getTotalAPIDuration()}ms lines ${tracker.getTotalLinesAdded()}`)
  const cost = plain(tracker.formatTotalCost())
  const headline = `Total cost:            ${tracker.formatSessionCost(expected.total, 0)}`
  const fableRow = new RegExp(`claude-fable-5-1:.*\\(${tracker.formatSessionCost(expected.byModel[FABLE]!.costUSD, 0).replace('$', '\\$')}\\)`)
  const sonnetRow = new RegExp(`claude-sonnet-5:.*\\(${tracker.formatSessionCost(expected.byModel[SONNET]!.costUSD, 0).replace('$', '\\$')}\\)`)
  check('/cost reads the rebuilt ledger: the headline and one row per model, each at its rebuilt figure', cost.includes(headline) && fableRow.test(cost) && sonnetRow.test(cost), cost)
  check('the slot is untouched by a restore (the save side is not this road)', getCurrentProjectConfig().lastSessionId === OTHER && getCurrentProjectConfig().lastCost === 9.99)
}

section('§2 usage the compaction-chain rehydration zeroes still sums from the raw file')
const SID2 = '00000000-aaaa-4000-8000-000000000002'
{
  const file = join(STORE, `${SID2}.jsonl`)
  writeFileSync(file, '')
  const r1 = exchange(file, SID2, null, FABLE, { input_tokens: 60000, output_tokens: 800, cache_read_input_tokens: 110000, cache_creation_input_tokens: 3000 })
  const head = uid()
  append(file, userRow(SID2, head, r1.uuid, 'the preserved head'))
  const tail = uid()
  const preservedUsage: Usage = { input_tokens: 61000, output_tokens: 950, cache_read_input_tokens: 112000, cache_creation_input_tokens: 0 }
  append(file, assistantRow(SID2, tail, head, FABLE, preservedUsage))
  const boundary = uid()
  append(file, {
    ...base(SID2, boundary, tail),
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    isMeta: false,
    level: 'info',
    compactMetadata: { trigger: 'auto', preTokens: 173000, preservedSegment: { headUuid: head, anchorUuid: boundary, tailUuid: tail } },
  })
  const r3 = exchange(file, SID2, boundary, SONNET, { input_tokens: 4000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 })
  const fold = await loadTranscriptFile(file)
  const preserved = fold.messages.get(tail as never)
  const preservedRaw = (preserved?.type === 'assistant' ? preserved.message.usage : undefined) as Usage | undefined
  check('the control: the rehydrated copy zeroes the preserved row (chain.ts) and prunes the pre-boundary rows', preservedRaw !== undefined && preservedRaw.input_tokens === 0 && preservedRaw.output_tokens === 0 && !fold.messages.has(r1.uuid as never), JSON.stringify({ preserved: preservedRaw, pruned: !fold.messages.has(r1.uuid as never) }))
  slotForOther()
  await resume(SID2)
  const expected = expectedOf([r1, { model: FABLE, usage: preservedUsage }, r3])
  const verdict = ledgerMatches(expected)
  check('RED ON THE BASE: the ledger sums the raw on-disk usage — the pruned row and the zeroed row included', verdict.ok, verdict.detail)
}

section('§3 a transcript with no usage records leaves the ledger at zero, no throw')
const SID3 = '00000000-aaaa-4000-8000-000000000003'
{
  const file = join(STORE, `${SID3}.jsonl`)
  writeFileSync(file, '')
  const u = uid()
  append(file, userRow(SID3, u, null, 'a prompt with no priced reply'))
  const a = uid()
  append(file, assistantRow(SID3, a, u, SYNTHETIC_MODEL, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }))
  slotForOther()
  let threw: string | null = null
  let restored: boolean | null = null
  try {
    restored = await resume(SID3)
  } catch (error) {
    threw = String(error)
  }
  check('the resume did not throw', threw === null, threw ?? '')
  check('nothing was restored and the ledger stays at zero', restored === false && tracker.getTotalCost() === 0 && Object.keys(tracker.getModelUsage()).length === 0, JSON.stringify({ restored, total: tracker.getTotalCost(), models: tracker.getModelUsage() }))
  const SID_ABSENT = '00000000-aaaa-4000-8000-00000000000a'
  const absent = await resume(SID_ABSENT)
  check('a session with no transcript file restores nothing and throws nothing', absent === false && tracker.getTotalCost() === 0)
}

section("§4 the project's last saver resumes to the same numbers the slot gave (the slot still carries what the transcript cannot)")
const SID4 = '00000000-aaaa-4000-8000-000000000004'
{
  const file = join(STORE, `${SID4}.jsonl`)
  writeFileSync(file, '')
  state.switchSession(SID4 as never, STORE)
  tracker.resetCostState()
  const rows: Row[] = []
  let parent: string | null = null
  for (const [model, usage] of [
    [FABLE, { input_tokens: 300, output_tokens: 120, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 }],
    [SONNET, { input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 1200 }],
    [FABLE, { input_tokens: 10, output_tokens: 2200, cache_read_input_tokens: 5300, cache_creation_input_tokens: 0 }],
  ] as Array<[string, Usage]>) {
    const row = exchange(file, SID4, parent, model, usage)
    parent = row.uuid
    rows.push(row)
    tracker.addToTotalSessionCost(calculateUSDCost(model, usage), usage as never, model)
  }
  state.addToTotalDurationState(3210, 3000)
  tracker.addToTotalLinesChanged(12, 3)
  tracker.saveCurrentSessionCosts()
  const slot = getCurrentProjectConfig()
  check('the control: the live leg saved the slot under this session', slot.lastSessionId === SID4 && (slot.lastCost ?? 0) > 0 && slot.lastAPIDuration === 3210 && slot.lastLinesAdded === 12, JSON.stringify({ id: slot.lastSessionId, cost: slot.lastCost }))
  const saved = { total: slot.lastCost ?? 0, byModel: Object.fromEntries(Object.entries(slot.lastModelUsage ?? {}).map(([m, u]) => [m, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadInputTokens: u.cacheReadInputTokens, cacheCreationInputTokens: u.cacheCreationInputTokens, costUSD: u.costUSD }])) }
  await resume(SID4)
  const verdict = ledgerMatches(saved)
  check('the resumed usage and cost equal the slot the live leg saved', verdict.ok, verdict.detail)
  const transcriptVerdict = ledgerMatches(expectedOf(rows))
  check('…and equal the transcript rebuild (one price owner, one sum)', transcriptVerdict.ok, transcriptVerdict.detail)
  check('the API durations and line counts ride the slot (the transcript does not carry them)', tracker.getTotalAPIDuration() === 3210 && tracker.getTotalAPIDurationWithoutRetries() === 3000 && tracker.getTotalLinesAdded() === 12 && tracker.getTotalLinesRemoved() === 3, `api ${tracker.getTotalAPIDuration()} lines +${tracker.getTotalLinesAdded()} -${tracker.getTotalLinesRemoved()}`)
}

section("§5 a sub-agent's records live in its own transcript; the parent's ledger counted them live, so the rebuild counts them")
const SID5 = '00000000-aaaa-4000-8000-000000000005'
{
  const file = join(STORE, `${SID5}.jsonl`)
  writeFileSync(file, '')
  const r1 = exchange(file, SID5, null, FABLE, { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  state.switchSession(SID5 as never, STORE)
  const agentFile = getAgentTranscriptPath('a1b2c3' as never)
  mkdirSync(join(agentFile, '..'), { recursive: true })
  writeFileSync(agentFile, '')
  const agentUsage: Usage = { input_tokens: 2500, output_tokens: 600, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 }
  const au = uid()
  append(agentFile, { ...userRow(SID5, au, null, 'the agent prompt'), isSidechain: true, agentId: 'a1b2c3' })
  const aa = uid()
  append(agentFile, { ...assistantRow(SID5, aa, au, SONNET, agentUsage), isSidechain: true, agentId: 'a1b2c3' })
  check('the control: the agent file sits under the session tree', agentFile.startsWith(join(STORE, SID5, 'subagents')), agentFile)
  slotForOther()
  await resume(SID5)
  const verdict = ledgerMatches(expectedOf([r1, { model: SONNET, usage: agentUsage }]))
  check("RED ON THE BASE: the sub-agent's response joins the rebuilt ledger under its own model", verdict.ok, verdict.detail)
}

section('§6 one API response counts once: sibling rows share the message id and a settled line supersedes the as-published one')
const SID6 = '00000000-aaaa-4000-8000-000000000006'
{
  const file = join(STORE, `${SID6}.jsonl`)
  writeFileSync(file, '')
  const u = uid()
  append(file, userRow(SID6, u, null, 'two parallel tool calls'))
  const started: Usage = { input_tokens: 400, output_tokens: 1, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 }
  const settled: Usage = { input_tokens: 400, output_tokens: 250, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 }
  const s1 = uid()
  const s2 = uid()
  append(file, assistantRow(SID6, s1, u, FABLE, started, 'msg_shared'))
  append(file, assistantRow(SID6, s2, s1, FABLE, started, 'msg_shared'))
  append(file, assistantRow(SID6, s2, s1, FABLE, settled, 'msg_shared'))
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  check('the control: the file holds three assistant lines for one response (two siblings, one settlement)', lines.length === 5, `${lines.length} lines`)
  slotForOther()
  await resume(SID6)
  const verdict = ledgerMatches(expectedOf([{ model: FABLE, usage: settled }]))
  check('RED ON THE BASE: the response is counted once, at its settled usage', verdict.ok, verdict.detail)
}

section('§7 the shape: the restore road reads the raw records through the reader; the slot is read for what the transcript cannot carry')
{
  const src = (rel: string): string => {
    try {
      return readFileSync(join(ROOT, 'src', rel), 'utf8')
    } catch {
      return ''
    }
  }
  const costTracker = src('cost-tracker.ts')
  const rollup = src('utils/sessionStorage/usageRollup.ts')
  const reader = src('utils/sessionStorage/transcriptReader.ts')
  const restore = src('utils/sessionRestore.ts')
  check('the restore road rolls the transcript up before it reads the slot', costTracker.includes('rollupSessionUsage(') && costTracker.includes('export async function restoreCostStateForSession('))
  check('the rollup reads the raw record stream through the one reader, never the file', rollup.includes('scanTranscriptEntriesForward(') && !/from ['"]node:fs['"]/.test(rollup) && !rollup.includes('readFileSync('))
  check('the rollup prices every response through the one price owner', rollup.includes('calculateUSDCost(') && rollup.includes('modelPricingBasis('))
  check('the reader exposes the raw forward walk (no fold, no relink, no prune)', reader.includes('export function scanTranscriptEntriesForward('))
  const callers = ['cli/print.ts', 'cli/headless/resume.ts'].map(rel => src(rel))
  check('the one restore road awaits the rebuild and hands it the transcript path it knows', restore.includes('export async function restoreSessionStateFromLog(') && restore.includes('await restoreCostStateForSession(adopted, result.fullPath)') && (restore.match(/restoreCostStateForSession\(/g) ?? []).length === 1)
  check('every road that restores a session awaits the restore, so the ledger is rebuilt before the first turn', callers.every(text => text.includes('await restoreSessionStateFromLog(') && !/(?<!await )restoreSessionStateFromLog\(/.test(text)))
}

rmSync(HOME, { recursive: true, force: true })
rmSync(STORE, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ ALL LEDGER-RESUME-REBUILD PROOFS PASS' : `\n❌ ${failures} LEDGER-RESUME-REBUILD PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
