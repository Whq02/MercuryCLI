#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

if (process.env.NODE_ENV === 'test') delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'resume-history-bytes-'))
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture-not-a-real-key'
delete process.env.MERCURY_THINKING_BINDING
delete process.env.MERCURY_PREFIX_INDUCE_EDIT
delete process.env.MERCURY_SKIP_PROMPT_HISTORY
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_HOME
delete process.env.CI
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0', PACKAGE_URL: 'https://github.com/example/mercury' }

import { bindingDropsFor, prefixHashOf, startFixtureApi, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const MODEL = 'claude-fable-5-1'
const SIGNATURE_PREFIX = 'fixture-signature:'

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
function note(t: string): void {
  console.log(`  · ${t}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — resume history proofs exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

type Block = Record<string, unknown>
type Row = { role?: string; content?: unknown }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const factories = await import('../../src/utils/messages/factories.ts')
const apiView = await import('../../src/utils/messages/apiView.ts')
const pairing = await import('../../src/utils/messages/pairing.ts')
const apiFilters = await import('../../src/utils/messages/apiFilters.ts')
const media = await import('../../src/services/providers/anthropic/media.ts')
const apiLimits = await import('../../src/constants/apiLimits.ts')
const retention = await import('../../src/services/desktop/screenshotRetention.ts')
const binding = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
const cache = await import('../../src/services/providers/anthropic/cacheAndUsage.ts')
const ledger = await import('../../src/services/providers/anthropic/prefixLedger.ts')
const writer = await import('../../src/utils/sessionStorage/writer.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const recovery = await import('../../src/utils/conversationRecovery.ts')
const state = await import('../../src/bootstrap/state.ts')
const resolveOwner = await import('../../src/services/run/resolveOwner.ts')

let seq = 0
const uuidOf = (): string => `0000c0de-0000-4000-8000-${String(++seq).padStart(12, '0')}`
let clock = Date.parse('2026-09-11T20:00:00.000Z')
const stampOf = (): string => new Date((clock += 1000)).toISOString()
const WIN_FILE = 'C:\\Users\\arlo\\proj\\src\\main.gd'
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const SHOTS_DIR = join(process.env.MERCURY_CONFIG_DIR!, 'desktop-shots')
mkdirSync(SHOTS_DIR, { recursive: true })
const SHOT = join(SHOTS_DIR, 'shot-0001.png')
writeFileSync(SHOT, Buffer.from(PNG, 'base64'))
const GONE_SHOT = 'C:\\Users\\arlo\\.mercury\\desktop-shots\\shot-0002.png'
const USAGE = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
const SYSTEM = [
  { type: 'text', text: 'You are Mercury.\n\n# Environment\n - Primary working directory: C:\\Users\\arlo\\proj\n - Platform: win32\n' },
  { type: 'text', text: 'gitStatus: clean' },
]
const TOOLS = ['Read', 'Edit', 'Bash', 'Computer'].map(name => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } }))

const thinkingBlocks = new Map<string, Block>()
function think(text: string): Block {
  const block: Block = { type: 'thinking', thinking: text, signature: 'pending' }
  thinkingBlocks.set(text, block)
  return block
}
function assistant(id: string, block: Block): Record<string, unknown> {
  return {
    message: { id, type: 'message', role: 'assistant', model: MODEL, content: [block], stop_reason: null, stop_sequence: null, usage: USAGE, context_management: null },
    requestId: `req_${id}`,
    type: 'assistant',
    uuid: uuidOf(),
    timestamp: stampOf(),
  }
}
function user(content: string | Block[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return factories.createUserMessage({ content: content as never, uuid: uuidOf(), timestamp: stampOf(), ...extra }) as unknown as Record<string, unknown>
}
function result(source: Record<string, unknown>, block: Block, toolUseResult: unknown): Record<string, unknown> {
  return user([block], { toolUseResult, sourceToolAssistantUUID: source.uuid })
}

const readUse = assistant('msg_01', { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { limit: 40, file_path: WIN_FILE, offset: 1.0 } })
const editUse = assistant('msg_02', { type: 'tool_use', id: 'toolu_02', name: 'Edit', input: { new_string: 'print("hi")\r\n', old_string: 'print("hello")\r\n', file_path: WIN_FILE, replace_all: undefined } })
const bashUse = assistant('msg_03', { type: 'tool_use', id: 'toolu_03', name: 'Bash', input: { command: 'dir C:\\Users\\arlo\\proj /s', description: 'List the project', timeout: 120000.0 } })
const shotUse = assistant('msg_04', { type: 'tool_use', id: 'toolu_04', name: 'Computer', input: { action: 'screenshot', display: 1.0 } })
const live: Record<string, unknown>[] = [
  user('Fix the greeting in main.gd and take a screenshot of the editor'),
  user([{ type: 'text', text: '<system-reminder>\r\nThe operator works on Windows; paths carry backslashes.\r\n</system-reminder>' }], { isMeta: true }),
  assistant('msg_01', think('read the file first')),
  readUse,
  result(readUse, { tool_use_id: 'toolu_01', type: 'tool_result', content: '     1\tfunc _ready():\r\n     2\t\tprint("hello")\r\n' }, { type: 'text', file: { filePath: WIN_FILE, content: 'func _ready():\r\n\tprint("hello")\r\n', numLines: 2, startLine: 1, totalLines: 2 } }),
  assistant('msg_02', think('edit the greeting')),
  editUse,
  result(editUse, { tool_use_id: 'toolu_02', type: 'tool_result', content: `The file ${WIN_FILE} has been updated.` }, { filePath: WIN_FILE, oldString: 'print("hello")\r\n', newString: 'print("hi")\r\n' }),
  assistant('msg_03', think('list the tree')),
  bashUse,
  result(bashUse, { type: 'tool_result', content: '<tool_use_error>Exit code 1\r\nFile Not Found\r\n</tool_use_error>', is_error: true, tool_use_id: 'toolu_03' }, 'Error: Exit code 1'),
  assistant('msg_04', think('look at the editor')),
  shotUse,
  result(shotUse, { tool_use_id: 'toolu_04', type: 'tool_result', content: [{ type: 'text', text: `screenshot: ${SHOT} — display 1 (1920×1080) · in front: Godot` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] }, { result: `screenshot: ${SHOT} — display 1`, imagePath: SHOT }),
  assistant('msg_05', think('all done')),
  assistant('msg_05', { type: 'text', text: 'Done — the greeting is fixed and the editor shows it.', citations: undefined }),
]

interface Wire { rows: unknown[]; ids: Array<string | null> }
function wireOf(messages: Record<string, unknown>[]): Wire {
  let rows = apiView.normalizeMessagesForAPI(messages as never, [])
  rows = pairing.orderToolResultsByUse(pairing.ensureToolResultPairing(rows))
  rows = pairing.stripUnsignedThinkingBlocks(rows)
  rows = media.stripExcessMediaItems(rows, apiLimits.API_MAX_MEDIA_PER_REQUEST)
  const retired = retention.retireOlderScreenshots(rows)
  rows = retired.firstEdited === -1 ? retired.messages : apiFilters.stripThinkingFromIndex(retired.messages, retired.firstEdited)
  rows = binding.stripDeadThinking(rows, binding.deadThinkingMarks(messages as never))
  const ids = rows.map(m => (m.type === 'assistant' ? m.message.id : null))
  return { rows: cache.addCacheBreakpoints(rows, true) as unknown[], ids }
}
const strip = ledger.withoutCacheControl
const contentOf = (row: unknown): Block[] => {
  const c = (row as Row).content
  return Array.isArray(c) ? (c as Block[]) : [{ type: 'text', text: String(c ?? '') }]
}
const isThinking = (b: Block | undefined): boolean => b?.type === 'thinking' || b?.type === 'redacted_thinking'
const countThinking = (rows: unknown[]): number => rows.reduce<number>((n, row) => n + contentOf(row).filter(isThinking).length, 0)
function firstDiffAt(a: string, b: string): number {
  let at = 0
  while (at < a.length && at < b.length && a[at] === b[at]) at++
  return at
}
const excerpt = (text: string, at: number): string => `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + 90)}${at + 90 < text.length ? '…' : ''}`
function blockOf(rows: unknown[], pick: (b: Block) => boolean): Block | undefined {
  for (const row of rows) for (const b of contentOf(row)) if (pick(b)) return b
  return undefined
}
const toolUse = (rows: unknown[], id: string): Block | undefined => blockOf(rows, b => b.type === 'tool_use' && b.id === id)
const toolResult = (rows: unknown[], id: string): Block | undefined => blockOf(rows, b => b.type === 'tool_result' && b.tool_use_id === id)

function mintSignatures(messages: Record<string, unknown>[]): void {
  const { rows } = wireOf(messages)
  rows.forEach((row, i) => {
    const r = row as Row
    if (r.role !== 'assistant' || !Array.isArray(r.content)) return
    for (const block of r.content as Block[]) {
      if (block.type !== 'thinking') continue
      const source = thinkingBlocks.get(String(block.thinking))
      if (source !== undefined) source.signature = `${SIGNATURE_PREFIX}${prefixHashOf({ system: SYSTEM, tools: TOOLS }, rows.slice(0, i))}:${MODEL}`
    }
  })
}

section('§1 the two roads, byte for byte — the live history and the same history read back from the session file')
mintSignatures(live)
const liveWire = wireOf(live)
await writer.recordTranscript(live as never)
await writer.flushSessionStorage()
const transcriptPath = paths.getTranscriptPath()
const sessionId = String(state.getSessionId())
check('the session file stands where the resume road reads it', existsSync(transcriptPath), transcriptPath)
const loaded = await recovery.loadConversationForResume(sessionId, transcriptPath)
const resumed = (loaded?.messages ?? []) as unknown as Record<string, unknown>[]
check('the resume road reads the whole history back (every persisted row, no sentinel appended after a finished turn)', resumed.length === live.length, `${live.length} written, ${resumed.length} read`)
const resumedWire = wireOf(resumed)
const last = ledger.lastThinkingMessageIndex(liveWire.rows)
note(`${liveWire.rows.length} wire rows on the live road, ${resumedWire.rows.length} on the resumed road; the last thinking block sits in messages[${last}]`)

interface Diff { where: string; kind: string; at: number; before: string; after: string }
const diffs: Diff[] = []
const signatureMoves: string[] = []
for (let k = 0; k <= last; k++) {
  const a = contentOf(liveWire.rows[k])
  const bRow = resumedWire.rows[k]
  if (bRow === undefined) {
    diffs.push({ where: `messages[${k}]`, kind: 'row', at: 0, before: j(strip(liveWire.rows[k])).slice(0, 130), after: '(no row on the resumed road)' })
    continue
  }
  const b = contentOf(bRow)
  const lastThinkingBlock = a.map((blk, i) => (isThinking(blk) ? i : -1)).filter(i => i >= 0).pop() ?? a.length
  const boundUpTo = k === last ? lastThinkingBlock : a.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ab = a[i]
    const bb = b[i]
    if (isThinking(ab) || isThinking(bb)) {
      if (ab?.signature !== bb?.signature) signatureMoves.push(`messages[${k}].content[${i}]`)
      continue
    }
    if (i >= boundUpTo) continue
    const sa = ab === undefined ? '' : j(strip(ab))
    const sb = bb === undefined ? '' : j(strip(bb))
    if (sa === sb) continue
    const at = firstDiffAt(sa, sb)
    diffs.push({ where: `messages[${k}].content[${i}]`, kind: `${String(ab?.type ?? 'absent')} → ${String(bb?.type ?? 'absent')}`, at, before: excerpt(sa, at), after: excerpt(sb, at) })
  }
}
for (const d of diffs) {
  note(`${d.where} (${d.kind}) differs at char ${d.at}`)
  note(`    live:    ${d.before}`)
  note(`    resumed: ${d.after}`)
}

const liveRead = toolUse(liveWire.rows, 'toolu_01')
const resumedRead = toolUse(resumedWire.rows, 'toolu_01')
check('a backslash path inside a tool_use input survives the round trip', j(resumedRead?.input) === j(liveRead?.input) && String((resumedRead?.input as Block | undefined)?.file_path) === WIN_FILE, j(resumedRead?.input))
check('the tool_use input keeps the key order it was built in (limit, file_path, offset)', Object.keys((resumedRead?.input as Block | undefined) ?? {}).join(',') === 'limit,file_path,offset', Object.keys((resumedRead?.input as Block | undefined) ?? {}).join(','))
check('a whole-valued float (1.0) reads back as the same number and the same bytes', (resumedRead?.input as Block | undefined)?.offset === 1 && j((resumedRead?.input as Block | undefined)?.offset) === '1')
const liveEdit = toolUse(liveWire.rows, 'toolu_02')
const resumedEdit = toolUse(resumedWire.rows, 'toolu_02')
check('a key present with an undefined value is absent on both wires (absent and undefined are one spelling)', !('replace_all' in ((resumedEdit?.input as Block | undefined) ?? {})) && j(resumedEdit?.input) === j(liveEdit?.input), j(resumedEdit?.input))
check('CRLF inside a tool_use input survives byte for byte', String((resumedEdit?.input as Block | undefined)?.new_string) === 'print("hi")\r\n')
const liveReadResult = toolResult(liveWire.rows, 'toolu_01')
const resumedReadResult = toolResult(resumedWire.rows, 'toolu_01')
check('CRLF inside a tool_result survives byte for byte', j(strip(resumedReadResult)) === j(strip(liveReadResult)) && String(resumedReadResult?.content).includes('\r\n'), j(strip(resumedReadResult)))
const keysOf = (b: Block | undefined): string => Object.keys((strip(b ?? {}) as Block) ?? {}).join(',')
check('a tool_result the live runner spelled id-first leaves both roads in the one canonical order (type, tool_use_id, content)', keysOf(resumedReadResult) === 'type,tool_use_id,content' && keysOf(liveReadResult) === 'type,tool_use_id,content', `live ${keysOf(liveReadResult)}; resumed ${keysOf(resumedReadResult)}`)
const liveError = toolResult(liveWire.rows, 'toolu_03')
const resumedError = toolResult(resumedWire.rows, 'toolu_03')
check('an error tool_result (the factory spelling, is_error true) is byte-identical across the roads', j(strip(resumedError)) === j(strip(liveError)) && resumedError?.is_error === true, j(strip(resumedError)))
const liveShot = toolResult(liveWire.rows, 'toolu_04')
const resumedShot = toolResult(resumedWire.rows, 'toolu_04')
const liveShotKinds = Array.isArray(liveShot?.content) ? (liveShot.content as Block[]).map(b => String(b.type)).join(',') : String(typeof liveShot?.content)
const resumedShotKinds = Array.isArray(resumedShot?.content) ? (resumedShot.content as Block[]).map(b => String(b.type)).join(',') : String(typeof resumedShot?.content)
check(`a computer-tool screenshot result carries the same blocks on both roads (live: ${liveShotKinds})`, j(strip(resumedShot)) === j(strip(liveShot)), `resumed: ${resumedShotKinds} — ${j(strip(resumedShot)).slice(0, 200)}`)
const goneStub = user([{ tool_use_id: 'toolu_09', type: 'tool_result', content: [{ type: 'text', text: `screenshot: ${GONE_SHOT} — display 1` }, { type: 'text', text: retention.screenshotStubText(GONE_SHOT) }] }])
const rehydrated = retention.rehydrateScreenshots([goneStub as never])
check('a stub whose screenshot file is gone stays a stub (the row is then named by the ledger, never invented)', rehydrated[0] === goneStub)
const firstRow = contentOf(resumedWire.rows[0])
check('the operator prompt and the meta reminder row coalesce into the first user row on both roads', j(strip(resumedWire.rows[0])) === j(strip(liveWire.rows[0])) && firstRow.length === 2 && String(firstRow[1]?.text).startsWith('<system-reminder>'), j(strip(resumedWire.rows[0])).slice(0, 200))
check('every replayed thinking block keeps its signature across the roads', signatureMoves.length === 0, signatureMoves.join(', '))
check('the resumed road yields the same number of wire rows as the live road', resumedWire.rows.length === liveWire.rows.length, `${liveWire.rows.length} live, ${resumedWire.rows.length} resumed`)
check(`every wire row ahead of the last thinking block (messages[0..${last}]) is byte-identical across the roads, cache_control aside`, diffs.length === 0, `${diffs.length} difference(s): ${diffs.map(d => d.where).join(', ')}`)
const liveDrops = bindingDropsFor({ system: SYSTEM, tools: TOOLS, messages: liveWire.rows, model: MODEL })
check("the fixture's replay of the API's binding check drops nothing on the live road (the minting is sound)", liveDrops.length === 0, j(liveDrops))
const resumedDrops = bindingDropsFor({ system: SYSTEM, tools: TOOLS, messages: resumedWire.rows, model: MODEL })
check("the fixture's replay of the API's binding check drops nothing on the resumed road", resumedDrops.length === 0, `${resumedDrops.length} of ${countThinking(liveWire.rows)} blocks dropped, the first at ${String((resumedDrops[0] as { path?: string } | undefined)?.path)}`)
ledger.resetPrefixLedger()
const conversationKey = `proof|${String(live[0]!.uuid)}|${MODEL}`
ledger.judgeAndRecordPrefix('proof-owner', conversationKey, { system: SYSTEM, tools: TOOLS, messages: liveWire.rows }, liveWire.ids)
ledger.takePrefixVerdict('proof-owner')
const crossRoad = ledger.judgeAndRecordPrefix('proof-owner', conversationKey, { system: SYSTEM, tools: TOOLS, messages: resumedWire.rows }, resumedWire.ids)
check("the prefix ledger, holding the live road's record, names no mismatch on the resumed road", crossRoad.compared && crossRoad.mismatch === null, crossRoad.mismatch ? ledger.describePrefixMismatch(crossRoad.mismatch) : 'not compared')

section('§2 the ledger survives a revive — the record persisted beside the session, read by a fresh process at its first request')
const owner = String(resolveOwner.processMainOwner())
const ownerKey = `${owner}|${String(live[0]!.uuid)}|${MODEL}`
const store = ledger as unknown as { prefixLedgerPath?: (sessionId?: string) => string }
const storePath = typeof store.prefixLedgerPath === 'function' ? store.prefixLedgerPath(sessionId) : ''
check("the ledger names the record's place: <config home>/sessions/<session id>/prefix-ledger.json", storePath.length > 0 && storePath === join(process.env.MERCURY_CONFIG_DIR!, 'sessions', sessionId, 'prefix-ledger.json'), storePath || 'prefixLedgerPath is not exported')
ledger.resetPrefixLedger()
binding.resetThinkingDropStates()
const partsA = { system: SYSTEM, tools: TOOLS, messages: liveWire.rows }
const firstJudge = ledger.judgeAndRecordPrefix(owner, ownerKey, partsA, liveWire.ids)
check('the first process judges its first request without a previous record (compared false, no mismatch)', !firstJudge.compared && firstJudge.mismatch === null)
const storedText = storePath.length > 0 && existsSync(storePath) ? readFileSync(storePath, 'utf8') : ''
check('the record is on disk after the request was judged', storedText.length > 0, storePath || 'no path')
let stored: { version?: number; owner?: string; record?: { key?: string; messages?: unknown[]; system?: Array<{ digest?: string }>; tools?: Array<{ name?: string }> } } = {}
try {
  stored = JSON.parse(storedText) as typeof stored
} catch {
  stored = {}
}
check('the file names the owner and the conversation key it belongs to', stored.owner === owner && stored.record?.key === ownerKey, storedText.slice(0, 200))
check(`the record holds one digest row per wire message (${liveWire.rows.length}), the tools by name and the system blocks by digest`, stored.record?.messages?.length === liveWire.rows.length && (stored.record?.tools ?? []).map(t => t.name).join(',') === 'Read,Edit,Bash,Computer' && (stored.record?.system ?? []).length === 2, storedText.slice(0, 200))
check('the record carries digests, never the messages (no prompt words, no tool output, no image bytes on disk)', storedText.length > 0 && !storedText.includes('func _ready') && !storedText.includes(PNG) && !storedText.includes('Fix the greeting'), storedText.slice(0, 200))
const mark = binding.prefixMarkOf(live as never, MODEL, { permissionMode: 'default' })
const drops = [{ type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'prefix_binding_mismatch' }]
const firstDrop = binding.classifyThinkingDrops(owner, drops, mark)
check("the first process records a first drop (the recurrence reading's starting point)", firstDrop.kind === 'first' && firstDrop.consecutive === 1, `${firstDrop.kind} ${firstDrop.consecutive}`)
ledger.resetPrefixLedger()
binding.resetThinkingDropStates()
const faithful = ledger.judgeAndRecordPrefix(owner, ownerKey, partsA, liveWire.ids)
check('a fresh process whose first request matches byte for byte compares and names nothing (no false alarm)', faithful.compared && faithful.mismatch === null, faithful.mismatch ? ledger.describePrefixMismatch(faithful.mismatch) : 'not compared')
ledger.resetPrefixLedger()
binding.resetThinkingDropStates()
const editedRows = liveWire.rows.map((row, k) => {
  if (k !== 2) return row
  const blocks = contentOf(row).map((b, i) => (i === 0 ? { ...b, content: '     1\tfunc _ready():\n     2\t\tprint("hello")\n' } : b))
  return { ...(row as Row), content: blocks }
})
const revived = ledger.judgeAndRecordPrefix(owner, ownerKey, { system: SYSTEM, tools: TOOLS, messages: editedRows }, liveWire.ids)
check("a fresh process compares its first request against what the old one sent (compared true)", revived.compared, 'compared false — the record was not read back')
check("…and names the part and the path instead of 'a client-side edit'", revived.mismatch?.part === "turn 2's user row: tool_result block 0" && revived.mismatch?.path === 'messages[2].content[0]', revived.mismatch ? ledger.describePrefixMismatch(revived.mismatch) : 'no mismatch named')
const secondDrop = binding.classifyThinkingDrops(owner, drops, mark, { byteMoved: revived.mismatch !== null })
check('the recurrence reading counts across the revive (a drop after a drop with unchanged marks is the second of a run)', secondDrop.kind === 'recurrent' && secondDrop.consecutive === 2, `${secondDrop.kind} ${secondDrop.consecutive}`)
if (revived.mismatch !== null && firstDrop.kind === 'first') {
  const outcome = { ...firstDrop, part: revived.mismatch.part }
  const words = binding.describeThinkingDrops(drops, outcome) ?? ''
  check("the receipt of such a first drop carries the ledger's clause", words.includes("Mercury's prefix ledger names the part that moved: turn 2's user row: tool_result block 0"), words)
}
ledger.resetPrefixLedger()
binding.resetThinkingDropStates()
const otherModel = ledger.judgeAndRecordPrefix(owner, `${owner}|${String(live[0]!.uuid)}|claude-opus-4-8`, partsA, liveWire.ids)
check('a conversation on another key (a model switch, a compaction) starts a fresh record — the persisted one is not read as a rewrite', !otherModel.compared && otherModel.mismatch === null)

section('§3 the wire — the built bundle: a session with preserved thinking, a fresh process resuming it with a system edit only it carries')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    interface RunResult { exit: number | null; stdout: string; stderr: string }
    interface Arena { home: string; cwd: string; env: Record<string, string> }
    function makeArena(fixture: FixtureApi, extraEnv: Record<string, string> = {}): Arena {
      const home = mkdtempSync(join(tmpdir(), 'resume-bytes-home-'))
      const cwd = mkdtempSync(join(tmpdir(), 'resume-bytes-cwd-'))
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(join(cwd, 'README.md'), '# fixture\n')
      return {
        home,
        cwd,
        env: {
          HOME: home,
          PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
          TERM: 'dumb',
          MERCURY_CONFIG_DIR: join(home, '.claude'),
          MERCURY_CREDENTIAL_STORE: 'file',
          ANTHROPIC_BASE_URL: fixture.url,
          ANTHROPIC_API_KEY: 'fixture-key-000',
          MERCURY_DAEMON_DIR: join(home, 'daemon'),
          MERCURY_TEAMS_DIR: join(home, 'teams'),
          MERCURY_THINKING_BINDING: 'drop_block',
          ...extraEnv,
        },
      }
    }
    function runStreaming(arena: Arena, args: string[], prompts: string[]): Promise<RunResult> {
      return new Promise(resolvePromise => {
        const child = spawn(nodeBin!, [DIST, ...args], { cwd: arena.cwd, env: arena.env })
        let stdout = ''
        let stderr = ''
        let sent = 0
        let resultsSeen = 0
        const sendNext = (): void => {
          if (sent >= prompts.length) {
            child.stdin.end()
            return
          }
          const prompt = prompts[sent]!
          sent++
          child.stdin.write(j({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
        }
        child.stdout.on('data', d => {
          stdout += d
          const results = stdout.split('\n').filter(l => l.includes('"type":"result"')).length
          while (resultsSeen < results) {
            resultsSeen++
            sendNext()
          }
        })
        child.stderr.on('data', d => (stderr += d))
        const killer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', exit => {
          clearTimeout(killer)
          resolvePromise({ exit, stdout, stderr })
        })
        child.on('spawn', () => sendNext())
      })
    }
    type Body = { system?: unknown; tools?: unknown; messages?: unknown[]; model?: string }
    const systemTextOf = (body: Body): string => (Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map(b => b.text ?? '').join('\n') : String(body.system ?? ''))
    function transcriptNotices(arena: Arena, sid: string): string[] {
      const walk = (dir: string): string[] => {
        const out: string[] = []
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) out.push(...walk(full))
          else if (entry.name === `${sid}.jsonl`) out.push(full)
        }
        return out
      }
      const files = existsSync(join(arena.home, '.claude', 'projects')) ? walk(join(arena.home, '.claude', 'projects')) : []
      const notices: string[] = []
      for (const file of files) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.includes('Preserved thinking')) continue
          try {
            const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
            if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') notices.push(row.payload.content)
          } catch {
            continue
          }
        }
      }
      return notices
    }
    const debugText = (file: string): string => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return ''
      }
    }
    const common = ['-p', '--input-format', 'stream-json', '--model', MODEL, '--allowed-tools', 'Read', '--output-format', 'stream-json']
    const scripted = (n: number): ScriptedTurn[] => Array.from({ length: n }, (_, i) => ({ kind: 'text' as const, text: `revive-T${i + 1}`, thinking: `revive thinking ${i + 1}`, model: MODEL }))
    const SID = 'c0ffee00-0000-4000-8000-00000000e001'
    const fixture = await startFixtureApi(scripted(3), { bindingCheck: true })
    const arena = makeArena(fixture)
    const firstDebug = join(arena.home, 'first.debug.log')
    const first = await runStreaming(arena, [...common, '--session-id', SID, '--debug-file', firstDebug], ['revive turn 1', 'revive turn 2'])
    check('[wire] the first process runs two turns and exits 0', first.exit === 0, `exit=${first.exit} stderr=${first.stderr.slice(0, 300)}`)
    const recordFile = join(arena.home, '.claude', 'sessions', SID, 'prefix-ledger.json')
    check("[wire] the first process left the ledger's record beside its session", existsSync(recordFile), recordFile)
    if (existsSync(recordFile)) note(`the record beside the session is ${statSync(recordFile).size} bytes after two turns`)
    const revivedDebug = join(arena.home, 'revived.debug.log')
    const revivedArena = { ...arena, env: { ...arena.env, MERCURY_PREFIX_INDUCE_EDIT: 'system' } }
    const second = await runStreaming(revivedArena, [...common, '--resume', SID, '--debug-file', revivedDebug], ['revive turn 3'])
    check('[wire] the revived process runs its turn and exits 0', second.exit === 0, `exit=${second.exit} stderr=${second.stderr.slice(0, 300)}`)
    const reqs = fixture.messageRequests().map(q => q.body as Body)
    check('[wire] three requests; only the revived one carries the system edit', reqs.length === 3 && !systemTextOf(reqs[1]!).includes('[induced edit]') && systemTextOf(reqs[2]!).endsWith('[induced edit]'), `${reqs.length} requests`)
    const dropped = second.stdout.split('\n').filter(l => l.includes('"type":"thinking_dropped"')).length > 0
    check("[wire] the fixture's binding check dropped the first process's blocks on the revived request", dropped)
    const notices = transcriptNotices(arena, SID)
    check("[wire] the receipt after the revive names the part instead of the bare 'client-side edit' sentence", notices.length >= 1 && notices.some(n => n.includes("Mercury's prefix ledger names the part that moved: the system prompt")), j(notices))
    const debug = debugText(revivedDebug)
    check("[wire] the revived process's debug log carries the ledger's line naming the part before the request went out", debug.includes('the prefix ledger names a rewrite of sent history before the request went out — the system prompt'), debug.split('\n').filter(l => l.includes('prefix ledger')).join(' | ').slice(0, 300))
    const doctorFile = join(arena.home, '.claude', 'preserved-thinking.json')
    const row = existsSync(doctorFile) ? (JSON.parse(readFileSync(doctorFile, 'utf8')) as { last?: { part?: string; kind?: string } }) : null
    check("[wire] the doctor's row carries the named part after the revive", typeof row?.last?.part === 'string' && row.last.part.startsWith('the system prompt') && row.last.kind === 'first', j(row))
    await fixture.close()
  }
}

console.log(`\n${failures === 0 ? '✅' : '❌'} resume history bytes: ${checks - failures}/${checks} checks passed`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
