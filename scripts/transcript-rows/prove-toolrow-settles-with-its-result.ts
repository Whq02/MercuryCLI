#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import stripAnsi from 'strip-ansi'

const ROOT = resolve(import.meta.dir, '..', '..')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'toolrow-settles-'))
const HOME = join(SCRATCH, 'home')
const DAEMON_DIR = join(SCRATCH, 'daemon')
const PROJECT = join(SCRATCH, 'project')
mkdirSync(HOME, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
delete process.env.MERCURY_HOME

const src = (rel: string): string => join(ROOT, 'src', rel)
const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default as typeof import('react')
const { default: Ink } = await import(src('ink/ink.tsx'))
const { App } = await import(src('components/App.tsx'))
const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
const { AppStateProvider } = await import(src('state/AppState.tsx'))
const { KeybindingSetup } = await import(src('keybindings/KeybindingProviderSetup.tsx'))
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import(src('context/surfaceRoute.ts'))
const { enableConfigs, saveCurrentProjectConfig } = await import(src('utils/config.ts'))
const { default: instances } = await import(src('ink/instances.ts'))
const slot = await import(src('services/engine-connector/focusedConnector.ts'))
const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
const { IDLE_LIVE } = await import(src('services/engine-connector/seatLive.ts'))
const { DaemonSessionConnector } = await import(src('services/engine-connector/daemonConnector.ts'))
const { publishSessionFacts, readSessionFacts } = await import(src('services/engine-connector/seatProjections.ts'))
const row = await import(src('components/messages/AssistantToolUseMessage.tsx'))
const { Message: MessageComponent } = await import(src('components/Message.tsx'))
const { Messages } = await import(src('components/Messages.tsx'))
const messageRow = (await import(src('components/MessageRow.tsx'))) as { toolStateMoved?: (prev: unknown, next: unknown) => boolean }
const toolStateMoved = messageRow.toolStateMoved ?? ((): boolean => { throw new Error('toolStateMoved is absent on this tree') })
const { deriveTranscriptRows } = await import(src('components/concourse/workerTranscriptFold.ts'))
const { getTools } = await import(src('tools.ts'))
const { EvalTool } = await import(src('tools/EvalTool/EvalTool.ts'))
const { FileEditTool } = await import(src('tools/FileEditTool/FileEditTool.ts'))
const { createLiveTurnFold, liveTurnStateOf } = await import(src('utils/conversationRecovery.ts'))
const { readTranscriptChainSince } = await import(src('utils/sessionStorage/transcriptReader.ts'))
const { buildMessageLookups, buildSubagentLookups } = await import(src('utils/messages/lookups.ts'))
const { normalizeMessages } = await import(src('utils/messages/normalize.ts'))
const openToolUseIDsOf = await import(src('utils/messages/openToolUses.ts')).then(
  m => (m as { openToolUseIDsOf: (messages: readonly unknown[]) => Set<string> }).openToolUseIDsOf,
  () => (): Set<string> => new Set<string>(['the shared law module is absent on this tree']),
)
const { INTERRUPT_MESSAGE_FOR_TOOL_USE } = await import(src('utils/messages/turnCut.ts'))
const { renderToString } = await import(src('utils/staticRender.tsx'))
const { WORK_FRAMES } = await import(src('utils/cockpit/liveGlyphs.ts'))
const { BLACK_CIRCLE } = await import(src('constants/figures.ts'))
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')

enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const h = React.createElement
let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const j = (v: unknown): string => JSON.stringify(v)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function until(pred: () => boolean, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pred()) return true
    await sleep(20)
  }
  return pred()
}
const hardLimit = setTimeout(() => {
  console.error('prove-toolrow-settles-with-its-result exceeded its deadline')
  process.exit(1)
}, 120_000)
hardLimit.unref()

type Rec = Record<string, unknown>
const SID = '00000000-aaaa-bbbb-cccc-000000000701'
const EVAL_ID = 'toolu_eval_measure_disk'
const EDIT_ID = 'toolu_edit_settings_store'
const iso = (at: number): string => new Date(at).toISOString()
const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
const uuidAt = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const assistantRec = (n: number, at: number, apiId: string, content: unknown[], stop: string): Rec => ({
  type: 'assistant',
  uuid: uuidAt(n),
  timestamp: iso(at),
  requestId: `req_${n}`,
  message: { id: apiId, type: 'message', role: 'assistant', model: 'fixture-model', content, stop_reason: stop, stop_sequence: null, usage },
})
const userRec = (n: number, at: number, content: unknown, extra: Rec = {}): Rec => ({
  type: 'user',
  uuid: uuidAt(n),
  timestamp: iso(at),
  message: { role: 'user', content },
  ...extra,
})
const bigText = Array.from({ length: 600 }, (_, i) => `line ${i} of the measured docker defaults, 60 GB of disk and 8 GB of memory by default`).join('\n')
const pngBase64 = Buffer.alloc(24_000, 7).toString('base64')
const evalOutput = {
  status: 'ok',
  language: 'js',
  title: "Read Docker's effective defaults and measure initial disk",
  executionCount: 5,
  stdout: { text: bigText, truncated: false },
  stderr: { text: '', truncated: false },
  displays: [
    { mime: 'text/plain', data: 'diskSizeMiB: 61440' },
    { mime: 'image/png', b64: true, data: pngBase64 },
  ],
  annotations: [],
  resultRepr: null,
  error: null,
  durationMs: 39_000,
}
const evalResultContent = [
  { type: 'text', text: `${bigText}\ndiskSizeMiB: 61440` },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
]
const settingsPath = join(PROJECT, 'settings-store.json')
const editInput = { file_path: settingsPath, old_string: '{', new_string: '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5,\n  "f": 6,' }
const editOutput = {
  filePath: settingsPath,
  oldString: '{',
  newString: editInput.new_string,
  originalFile: '{}',
  structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 7, lines: ['-{', '+{', '+  "a": 1,', '+  "b": 2,', '+  "c": 3,', '+  "d": 4,', '+  "e": 5,', '+  "f": 6,'] }],
  userModified: false,
  replaceAll: false,
}
function turnRecords(t0: number): { prompt: Rec; evalUse: Rec; evalResult: Rec; editUse: Rec; editResult: Rec; answer: Rec } {
  return {
    prompt: userRec(11, t0, 'measure docker and pin its settings'),
    evalUse: assistantRec(12, t0 + 1_000, 'msg_eval_1', [{ type: 'tool_use', id: EVAL_ID, name: 'Eval', input: { language: 'js', title: evalOutput.title, code: 'display(measure())' } }], 'tool_use'),
    evalResult: userRec(13, t0 + 40_000, [{ type: 'tool_result', tool_use_id: EVAL_ID, content: evalResultContent }], { toolUseResult: evalOutput }),
    editUse: assistantRec(14, t0 + 46_000, 'msg_edit_1', [{ type: 'tool_use', id: EDIT_ID, name: 'Edit', input: editInput }], 'tool_use'),
    editResult: userRec(15, t0 + 90_000, [{ type: 'tool_result', tool_use_id: EDIT_ID, content: 'The file has been updated.' }], { toolUseResult: editOutput }),
    answer: assistantRec(16, t0 + 95_000, 'msg_answer_1', [{ type: 'text', text: 'Docker keeps 60 GB by default; the settings file now pins it.' }], 'end_turn'),
  }
}
const seedBase = (extra: Rec): Rec => ({ isSidechain: false, entrypoint: 'cli', cwd: PROJECT, sessionId: SID, version: '1.0.0-beta.1', gitBranch: 'main', ...extra })
function chained(records: Rec[]): Rec[] {
  let parent: string | null = null
  return records.map(rec => {
    const out = seedBase({ parentUuid: parent, ...rec })
    parent = rec.uuid as string
    return out
  })
}
const workGlyph = (line: string): boolean => WORK_FRAMES.some(f => line.includes(f))
const tailOf = (line: string): string | null => /· (\d+)s(?:\s|$)/.exec(line)?.[1] ?? null

section('§A the record road — the reader and the fold the connector uses carry a large Eval result and an Edit result to an empty set')
{
  const T0 = Date.parse('2026-06-19T12:00:00.000Z')
  const r = turnRecords(T0)
  const rows = chained([r.prompt, r.evalUse, r.evalResult, r.editUse, r.editResult, r.answer])
  const path = join(PROJECT, `${SID}.jsonl`)
  writeFileSync(path, encodeSeedTranscript(rows, SID))
  const chain = await readTranscriptChainSince(path, null)
  const ids = (m: unknown): string[] => {
    const rec = m as { type?: string; message?: { content?: unknown } }
    if (!Array.isArray(rec.message?.content)) return []
    return (rec.message.content as Array<{ type?: string; tool_use_id?: string }>).flatMap(b => (b.type === 'tool_result' && b.tool_use_id ? [b.tool_use_id] : []))
  }
  const resultIds = chain.rows.flatMap(ids)
  check('the reader hands every record of the turn back, both results included', chain.rows.length === 6 && resultIds.includes(EVAL_ID) && resultIds.includes(EDIT_ID), j({ rows: chain.rows.length, resultIds }))
  const evalRow = chain.rows.find(m => ids(m).includes(EVAL_ID)) as { message?: { content?: unknown[] } } | undefined
  const evalBlocks = (evalRow?.message?.content ?? []) as Array<{ type?: string; content?: unknown }>
  const evalText = evalBlocks[0]?.content
  check('the Eval result keeps its text and image blocks whole through the reader', Array.isArray(evalText) && evalText.length === 2 && JSON.stringify(evalText[0]).includes('diskSizeMiB: 61440') && (evalText[1] as { type?: string }).type === 'image', j({ blocks: Array.isArray(evalText) ? evalText.length : evalText }))
  const fold = createLiveTurnFold()
  const settled = fold.fold(chain.rows as never, 0)
  check('the fold settles the turn: no tool in progress, not in flight', settled.inProgressToolUseIDs.size === 0 && settled.inFlight === false && settled.phase === 'idle', j({ ids: [...settled.inProgressToolUseIDs], inFlight: settled.inFlight, phase: settled.phase }))
  const midTurn = liveTurnStateOf([r.prompt, r.evalUse, r.evalResult, r.editUse, r.editResult] as never)
  check('with both results landed and no answer yet, the set is empty even mid-turn', midTurn.inProgressToolUseIDs.size === 0, j([...midTurn.inProgressToolUseIDs]))
  const evalOpen = liveTurnStateOf([r.prompt, r.evalUse] as never)
  const editOpen = liveTurnStateOf([r.prompt, r.evalUse, r.evalResult, r.editUse] as never)
  check('before each result lands, exactly that tool is in progress', evalOpen.inProgressToolUseIDs.has(EVAL_ID) && evalOpen.inProgressToolUseIDs.size === 1 && editOpen.inProgressToolUseIDs.has(EDIT_ID) && editOpen.inProgressToolUseIDs.size === 1, j({ evalOpen: [...evalOpen.inProgressToolUseIDs], editOpen: [...editOpen.inProgressToolUseIDs] }))
  const incremental = createLiveTurnFold()
  incremental.fold(chain.rows.slice(0, 2) as never, 0)
  incremental.fold(chain.rows.slice(0, 4) as never, 2)
  const appended = incremental.fold(chain.rows as never, 4)
  check('the append road (settled prefix, folded tail) reaches the same empty set', appended.inProgressToolUseIDs.size === 0 && appended.inFlight === false, j([...appended.inProgressToolUseIDs]))
  const normalized = normalizeMessages(chain.rows as never)
  const lookups = buildMessageLookups(normalized as never, chain.rows as never)
  check('the lookups resolve both tools and hold both result rows', lookups.resolvedToolUseIDs.has(EVAL_ID) && lookups.resolvedToolUseIDs.has(EDIT_ID) && lookups.toolResultByToolUseID.has(EVAL_ID) && lookups.toolResultByToolUseID.has(EDIT_ID), j([...lookups.resolvedToolUseIDs]))
  const tools = getTools(getDefaultAppState().toolPermissionContext)
  const derived = deriveTranscriptRows(chain.rows as never, tools)
  check('the worker fold over the same rows reports nothing in progress', derived.inProgress.size === 0, j([...derived.inProgress]))

  const record = { sessionId: SID, runnerId: 'concourse-w1', title: 'settles', projectLabel: 'scratch', workspaceId: PROJECT, home: PROJECT }
  const seat = new DaemonSessionConnector(record as never)
  await seat.attach()
  const live = seat.live()
  const seatResultIds = (seat.records() as unknown[]).flatMap(ids)
  check('the attached connector holds both result records and publishes an idle view with an empty set', seatResultIds.includes(EVAL_ID) && seatResultIds.includes(EDIT_ID) && live.inFlight === false && live.inProgressToolUseIDs.size === 0, j({ seatResultIds, inFlight: live.inFlight, ids: [...live.inProgressToolUseIDs] }))
  seat.detach()
}

section('§B the screen road — the rows over identity-kept records settle when the results land (the memo let the settle through)')
{
  class Output extends EventEmitter {
    isTTY = true
    columns: number
    rows: number
    constructor(columns: number, rows: number) {
      super()
      this.columns = columns
      this.rows = rows
    }
    write(): boolean {
      return true
    }
  }
  class Input extends EventEmitter {
    isTTY = true
    isRaw = false
    setEncoding(): this {
      return this
    }
    setRawMode(value: boolean): this {
      this.isRaw = value
      return this
    }
    ref(): this {
      return this
    }
    unref(): this {
      return this
    }
    read(): string | null {
      return null
    }
    get readableLength(): number {
      return 0
    }
  }
  const now = Date.now()
  const r = turnRecords(now - 100_000)
  const runningLive = (ids: string[]): typeof IDLE_LIVE => ({ ...IDLE_LIVE, inFlight: true, phase: 'tool' as const, agentsWaiting: 0 as const, inProgressToolUseIDs: new Set(ids), turnStartedAtMs: now - 100_000 })
  const recordListeners = new Set<() => void>()
  const liveListeners = new Set<() => void>()
  let records: Rec[] = [r.prompt, r.evalUse]
  let live: typeof IDLE_LIVE = runningLive([EVAL_ID])
  const seat = Object.assign(Object.create(noSessionConnector()), {
    sessionId: () => 'session-settles',
    records: () => records,
    subscribeRecords: (l: () => void) => {
      recordListeners.add(l)
      return () => {
        recordListeners.delete(l)
      }
    },
    turnActive: () => live.inFlight,
    live: () => live,
    subscribeLive: (l: () => void) => {
      liveListeners.add(l)
      return () => {
        liveListeners.delete(l)
      }
    },
    tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
  })
  const setRecords = (next: Rec[]): void => {
    records = next
    for (const l of recordListeners) l()
  }
  const setLive = (next: typeof IDLE_LIVE): void => {
    live = next
    for (const l of liveListeners) l()
  }
  slot.setFocusedSessionConnector(seat)
  const tools = [...getTools(getDefaultAppState().toolPermissionContext).filter(t => t.name !== 'Eval' && t.name !== 'Edit'), EvalTool, FileEditTool]
  function Harness(): React.ReactNode {
    const liveNow = React.useSyncExternalStore(seat.subscribeLive as never, seat.live as never, seat.live as never) as typeof IDLE_LIVE
    const recs = React.useSyncExternalStore(seat.subscribeRecords as never, seat.records as never, seat.records as never) as Rec[]
    return h(
      KeybindingSetup,
      null,
      h(Messages as never, {
        messages: recs,
        tools,
        commands: [],
        verbose: false,
        toolJSX: null,
        toolUseConfirmQueue: [],
        inProgressToolUseIDs: liveNow.inProgressToolUseIDs,
        isMessageSelectorVisible: false,
        conversationId: 'settles',
        screen: 'prompt',
        streamingToolUses: [],
        isLoading: liveNow.inFlight,
        suppressLogo: true,
      } as never),
    )
  }
  row._seedToolStartStamp(EVAL_ID, now - 99_000)
  row._seedToolStartStamp(EDIT_ID, now - 54_000)
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  const stdout = new Output(140, 40)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(140, 40) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: { ...getDefaultAppState(), expandedView: 'none' }, getFpsMetrics: () => undefined }, h(Harness)))
  const frame = (): string => stripAnsi(ink.lastFrameText())
  const lines = (): string[] => frame().split('\n').map(l => l.replace(/\s+$/, ''))
  const rowLine = (marker: string): string | undefined => lines().find(l => l.includes(marker))
  await until(() => rowLine('measure initial disk') !== undefined)
  await sleep(1_100)
  const runningEval = rowLine('measure initial disk') ?? ''
  console.log(`  frame while the Eval runs:\n${lines().filter(l => l.trim() !== '').map(l => `    ${l}`).join('\n')}`)
  check('while the Eval runs, its row wears the work glyph and a tail read from the record clock (about 99 s)', workGlyph(runningEval) && tailOf(runningEval) !== null && Number(tailOf(runningEval)) >= 98 && Number(tailOf(runningEval)) <= 105, runningEval)

  setRecords([...records, r.evalResult, r.editUse])
  setLive(runningLive([EDIT_ID]))
  await until(() => rowLine('settings-store.json') !== undefined)
  await sleep(2_500)
  const midEval = rowLine('measure initial disk') ?? ''
  const runningEdit = rowLine('settings-store.json') ?? ''
  console.log(`  frame while the Edit runs:\n${lines().filter(l => l.trim() !== '').map(l => `    ${l}`).join('\n')}`)
  check('THE DEFECT PIN (mid-turn): once the Eval result lands, the Eval row stops counting while the turn goes on', tailOf(midEval) === null && midEval.includes(BLACK_CIRCLE) && !workGlyph(midEval), midEval)
  check('…and the Update row now runs with its own tail read from its record clock (about 57 s)', workGlyph(runningEdit) && tailOf(runningEdit) !== null && Number(tailOf(runningEdit)) >= 56 && Number(tailOf(runningEdit)) <= 63, runningEdit)

  setRecords([...records, r.editResult, r.answer])
  setLive(IDLE_LIVE)
  await until(() => frame().includes('the settings file now pins it'))
  await sleep(2_500)
  const settledEdit = rowLine('settings-store.json') ?? ''
  const settledEval = rowLine('measure initial disk') ?? ''
  console.log(`  settled frame:\n${lines().filter(l => l.trim() !== '').map(l => `    ${l}`).join('\n')}`)
  check('the result rows painted: the Eval body and the Edit diff card stand under their calls', frame().includes('ran · js · cell 5 · 2 display(s)') && frame().includes('Added 7 lines, removed 1 line'), frame().slice(0, 400))
  check('THE DEFECT PIN: the Update row stops counting once its result stands (no seconds tail on the row)', tailOf(settledEdit) === null, settledEdit)
  check('…and the Eval row stops counting too', tailOf(settledEval) === null, settledEval)
  check('the Update row wears the settled dot, never the work glyph, once the turn is over', settledEdit.includes(BLACK_CIRCLE) && !workGlyph(settledEdit), settledEdit)
  check('the Eval row wears the settled dot too', settledEval.includes(BLACK_CIRCLE) && !workGlyph(settledEval), settledEval)
  check('the settled Edit row carries its edit meta tail (the row re-rendered with its result)', settledEdit.includes('+7/-1'), settledEdit)
  check('no line of the settled frame counts seconds', lines().every(l => tailOf(l) === null), j(lines().filter(l => tailOf(l) !== null)))
  ink.unmount()
  await ink.waitUntilExit()
  instances.delete(stdout as never)
  slot._resetFocusedSessionConnectorForTesting()

  const idleRecords = [r.prompt, r.evalUse, r.evalResult, r.editUse, r.editResult, r.answer]
  const runningRecords = [r.prompt, r.evalUse, r.evalResult, r.editUse]
  const before = buildMessageLookups(normalizeMessages(runningRecords as never) as never, runningRecords as never)
  const after = buildMessageLookups(normalizeMessages(idleRecords as never) as never, idleRecords as never)
  const editRow = normalizeMessages([r.editUse] as never)[0]!
  const editRunning = runningLive([EDIT_ID]).inProgressToolUseIDs
  const moved = (prev: unknown, next: unknown): boolean | string => {
    try {
      return toolStateMoved(prev, next)
    } catch (error) {
      return String(error)
    }
  }
  const landed = moved({ message: editRow, inProgressToolUseIDs: editRunning, lookups: before }, { message: editRow, inProgressToolUseIDs: IDLE_LIVE.inProgressToolUseIDs, lookups: after })
  check('the row memo law: a call whose result landed moves the row (resolved flipped)', landed === true, String(landed))
  const left = moved({ message: editRow, inProgressToolUseIDs: editRunning, lookups: before }, { message: editRow, inProgressToolUseIDs: IDLE_LIVE.inProgressToolUseIDs, lookups: before })
  check('the row memo law: a call that left the in-flight set alone moves the row', left === true, String(left))
  const calm = moved({ message: editRow, inProgressToolUseIDs: IDLE_LIVE.inProgressToolUseIDs, lookups: after }, { message: editRow, inProgressToolUseIDs: IDLE_LIVE.inProgressToolUseIDs, lookups: after })
  check('the row memo law: the same state on both sides moves nothing (the memo still bails on calm ticks)', calm === false, String(calm))
}

section('§C the safety law — a call a later reply or prompt stands after is resolved by definition, on both roads alike')
{
  const T0 = Date.parse('2026-06-19T13:00:00.000Z')
  const prompt = userRec(21, T0, 'run it')
  const orphan = assistantRec(22, T0 + 1_000, 'msg_orphan_1', [{ type: 'tool_use', id: 'toolu_orphan', name: 'Bash', input: { command: 'sleep 5' } }], 'tool_use')
  const sibling = assistantRec(23, T0 + 1_500, 'msg_orphan_1', [{ type: 'tool_use', id: 'toolu_sibling', name: 'Bash', input: { command: 'sleep 6' } }], 'tool_use')
  const reply = assistantRec(24, T0 + 9_000, 'msg_reply_1', [{ type: 'text', text: 'done, the command printed nothing' }], 'end_turn')
  const nextCall = assistantRec(25, T0 + 9_000, 'msg_reply_2', [{ type: 'tool_use', id: 'toolu_next', name: 'Bash', input: { command: 'ls' } }], 'tool_use')
  const nextPrompt = userRec(26, T0 + 20_000, 'and now the other thing')
  const cut = userRec(27, T0 + 5_000, [{ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE }])
  const both = (records: Rec[]): { fold: Set<string>; lookups: Set<string>; sub: Set<string>; law: Set<string> } => {
    const normalized = normalizeMessages(records as never)
    const lookups = buildMessageLookups(normalized as never, records as never)
    const sub = buildSubagentLookups(normalized.filter(m => m.type === 'user' || m.type === 'assistant').map(message => ({ message })) as never)
    return { fold: liveTurnStateOf(records as never).inProgressToolUseIDs, lookups: lookups.resolvedToolUseIDs, sub: sub.inProgressToolUseIDs, law: openToolUseIDsOf(records as never) }
  }
  const same = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every(x => b.has(x))

  const open = both([prompt, orphan])
  check('an unanswered call at the end of the record is open on every road', open.fold.has('toolu_orphan') && !open.lookups.has('toolu_orphan') && open.sub.has('toolu_orphan') && open.law.has('toolu_orphan'), j({ fold: [...open.fold], resolved: [...open.lookups], sub: [...open.sub] }))
  const answered = both([prompt, orphan, reply])
  check('a later reply resolves the unanswered call: the fold drops it, the lookups resolve it, the subagent road drops it', answered.fold.size === 0 && answered.lookups.has('toolu_orphan') && answered.sub.size === 0 && answered.law.size === 0, j({ fold: [...answered.fold], resolved: [...answered.lookups], sub: [...answered.sub] }))
  const state = liveTurnStateOf([prompt, orphan, reply] as never)
  check('…and the fold reads the turn as over (idle, not a tool phase)', state.inFlight === false && state.phase === 'idle', j({ inFlight: state.inFlight, phase: state.phase }))
  const chainedCall = both([prompt, orphan, nextCall])
  check('a later call from another reply resolves the old one and leaves only the new one open', same(chainedCall.fold, new Set(['toolu_next'])) && chainedCall.lookups.has('toolu_orphan') && !chainedCall.lookups.has('toolu_next') && same(chainedCall.sub, new Set(['toolu_next'])), j({ fold: [...chainedCall.fold], resolved: [...chainedCall.lookups], sub: [...chainedCall.sub] }))
  const siblings = both([prompt, orphan, sibling])
  check('a second record of the SAME reply (a sibling call) resolves nothing: both stay open', same(siblings.fold, new Set(['toolu_orphan', 'toolu_sibling'])) && siblings.lookups.size === 0 && same(siblings.sub, new Set(['toolu_orphan', 'toolu_sibling'])), j({ fold: [...siblings.fold], resolved: [...siblings.lookups], sub: [...siblings.sub] }))
  const prompted = both([prompt, orphan, nextPrompt])
  check('a later prompt resolves the unanswered call on every road', prompted.fold.size === 0 && prompted.lookups.has('toolu_orphan') && prompted.sub.size === 0, j({ fold: [...prompted.fold], resolved: [...prompted.lookups], sub: [...prompted.sub] }))
  const cutOff = both([prompt, orphan, cut])
  check("a cut row (the operator's interruption) is not a continuation: the call stays open, never dressed as done", cutOff.fold.has('toolu_orphan') && !cutOff.lookups.has('toolu_orphan') && cutOff.sub.has('toolu_orphan'), j({ fold: [...cutOff.fold], resolved: [...cutOff.lookups], sub: [...cutOff.sub] }))
  const cutThenPrompt = both([prompt, orphan, cut, nextPrompt])
  check('…until the operator moves on with a new prompt', cutThenPrompt.fold.size === 0 && cutThenPrompt.lookups.has('toolu_orphan'), j({ fold: [...cutThenPrompt.fold], resolved: [...cutThenPrompt.lookups] }))
  const queuedEcho = { ...userRec(28, T0 + 3_000, 'and after that, run the tests'), queued: true }
  const queuedWhileRunning = both([prompt, orphan, queuedEcho])
  check("words the operator queued while the tool runs (the connector's echo row) resolve nothing: the call stays open", queuedWhileRunning.fold.has('toolu_orphan') && !queuedWhileRunning.lookups.has('toolu_orphan') && queuedWhileRunning.sub.has('toolu_orphan'), j({ fold: [...queuedWhileRunning.fold], resolved: [...queuedWhileRunning.lookups], sub: [...queuedWhileRunning.sub] }))
  const virtualWords = { ...assistantRec(29, T0 + 2_000, 'msg_streaming_1', [{ type: 'text', text: 'let me run that' }], 'end_turn'), isVirtual: true }
  const wordsWhileRunning = both([prompt, orphan, virtualWords])
  check("the words a reply writes while its call runs (the connector's virtual text row) resolve nothing either", wordsWhileRunning.fold.has('toolu_orphan') && !wordsWhileRunning.lookups.has('toolu_orphan') && wordsWhileRunning.sub.has('toolu_orphan'), j({ fold: [...wordsWhileRunning.fold], resolved: [...wordsWhileRunning.lookups], sub: [...wordsWhileRunning.sub] }))
  for (const [name, records] of [['answered', [prompt, orphan, reply]], ['chained', [prompt, orphan, nextCall]], ['siblings', [prompt, orphan, sibling]], ['prompted', [prompt, orphan, nextPrompt]], ['cut', [prompt, orphan, cut]]] as Array<[string, Rec[]]>) {
    const r = both(records)
    check(`the two roads agree with the one law (${name}): fold set = subagent set = the law's open set`, same(r.fold, r.law) && same(r.sub, r.law), j({ fold: [...r.fold], sub: [...r.sub], law: [...r.law] }))
  }

  const SID2 = '00000000-aaaa-bbbb-cccc-000000000702'
  const orphanRows = chained([prompt, orphan, reply].map(rec => ({ ...rec, sessionId: SID2 })))
  writeFileSync(join(PROJECT, `${SID2}.jsonl`), encodeSeedTranscript(orphanRows, SID2))
  const facts = {
    schema: 1 as const,
    sessionId: SID2,
    atMs: Date.now(),
    model: { effective: 'fixture-model', setting: null },
    usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false },
    identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null },
    skills: [],
    mcp: [],
    permissionMode: 'default' as const,
    workspace: { cwd: PROJECT, originalCwd: PROJECT, projectRoot: PROJECT, instructionRoots: [] },
    queue: [],
    pendingModel: null,
    busy: true,
  }
  publishSessionFacts(facts as never, DAEMON_DIR)
  await until(() => (readSessionFacts(SID2, DAEMON_DIR) as { busy?: boolean } | null)?.busy === true)
  const record = { sessionId: SID2, runnerId: 'concourse-w1', title: 'orphan', projectLabel: 'scratch', workspaceId: PROJECT, home: PROJECT }
  const seat = new DaemonSessionConnector(record as never)
  await seat.attach()
  const busy = await until(() => seat.live().inFlight === true)
  const seatLive = seat.live()
  check('on the attached road with BUSY facts, an unanswered call a reply stands after never reaches the rows (the law, not the idle gate)', busy && seatLive.inProgressToolUseIDs.size === 0 && seatLive.phase !== 'tool', j({ inFlight: seatLive.inFlight, phase: seatLive.phase, ids: [...seatLive.inProgressToolUseIDs] }))
  seat.detach()
}

section('§D the tail reads the record clock — a running row painted late still names its true age')
{
  const baseLookups = {
    siblingToolUseIDs: new Map(),
    progressMessagesByToolUseID: new Map(),
    inProgressHookCounts: new Map(),
    resolvedHookCounts: new Map(),
    toolResultByToolUseID: new Map(),
    toolUseByToolUseID: new Map(),
    normalizedMessageCount: 1,
    resolvedToolUseIDs: new Set<string>(),
    erroredToolUseIDs: new Set<string>(),
    deniedToolUseIDs: new Set<string>(),
    recoveredStreamFaultUuids: new Set<string>(),
  }
  const tools = getTools(getDefaultAppState().toolPermissionContext)
  const oldCall = normalizeMessages([assistantRec(31, Date.now() - 100_000, 'msg_old', [{ type: 'tool_use', id: 'toolu_late_paint', name: 'Bash', input: { command: 'sleep 200' } }], 'tool_use')] as never)[0]!
  const painted = await renderToString(
    h(
      AppStateProvider as never,
      {},
      h(MessageComponent as never, {
        message: oldCall,
        tools,
        commands: [],
        verbose: false,
        addMargin: false,
        shouldAnimate: true,
        shouldShowDot: true,
        isTranscriptMode: false,
        isStatic: false,
        inProgressToolUseIDs: new Set(['toolu_late_paint']),
        progressMessagesForMessage: [],
        lookups: baseLookups,
      } as never),
    ),
    120,
  )
  const paintedLine = painted.split('\n').find(l => l.includes('sleep 200')) ?? ''
  check('a row first painted 100 s after its record says about 100 s, not 0 (no stamp was seeded at the paint)', tailOf(paintedLine) !== null && Number(tailOf(paintedLine)) >= 99 && Number(tailOf(paintedLine)) <= 104, j(paintedLine))
  const direct = (await renderToString(h(row.RunningToolElapsed as never, { id: 'toolu_direct_clock', running: true, startedAtMs: Date.now() - 42_000 } as never))).trim()
  check('RunningToolElapsed with a record clock reads it', /· 4[1-3]s/.test(direct), j(direct))
  const fresh = (await renderToString(h(row.RunningToolElapsed as never, { id: 'toolu_fresh_clock', running: true, startedAtMs: Date.now() - 3_000 } as never))).trim()
  check('the 10 s visibility floor still holds over the record clock', fresh === '', j(fresh))
  row._seedToolStartStamp('toolu_prover_seed', Date.now() - 30_000)
  const seeded = (await renderToString(h(row.RunningToolElapsed as never, { id: 'toolu_prover_seed', running: true } as never))).trim()
  check('a row without a record clock still takes the prover seam (_seedToolStartStamp)', /· (29|3[01])s/.test(seeded), j(seeded))
  const future = (await renderToString(h(row.RunningToolElapsed as never, { id: 'toolu_future_clock', running: true, startedAtMs: Date.now() + 60_000 } as never))).trim()
  check('a record clock ahead of this machine never paints a negative age', future === '', j(future))
}

clearTimeout(hardLimit)
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-toolrow-settles-with-its-result: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
