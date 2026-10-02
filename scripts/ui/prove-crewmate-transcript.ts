#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crewmate-transcript-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.FORCE_COLOR = '3'
delete process.env.MERCURY_RECESS
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const SESSION_ID = 'lead-session'
const CREW = 'compact-language'
const NAME = 'k3-native'
const ADDRESS = `${NAME}@${CREW}`
const HOSTED_WRITER_ID = 'a2hostedk'
const LOCAL_WRITER_ID = 'a3localk3'
const LOCAL_TASK_ID = 't4seatk3n'
const MODEL = 'k3'
const NEEDLE = 'K3-ROW'
const TEXT_ROWS = 2
const TOOL_ROWS = 1

let checks = 0
let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(10)
  return predicate()
}
class Output extends EventEmitter {
  isTTY = true
  constructor(public columns: number, public rows: number) { super() }
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
  get readableLength(): number { return 0 }
}
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const deadline = setTimeout(() => { console.error('crewmate-transcript exceeded its deadline'); process.exit(1) }, 120_000)
deadline.unref()

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const { default: instances } = await import('../../src/ink/instances.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { crewAgentFactsOf } = await import('../../src/services/engine-connector/crewFacts.ts')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const { createTaskStateBase } = await import('../../src/Task.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const transcript = await import('../../src/components/tasks/useCrewmateTranscript.ts')
const { useCrewmateModel } = await import('../../src/components/tasks/useCrewmateModel.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
type CrewmateInView = import('../../src/components/tasks/useCrewmateView.ts').CrewmateInView
type CrewAgentFacts = import('../../src/services/engine-connector/crewFacts.ts').CrewAgentFacts
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1
type TaskState = import('../../src/tasks/types.ts').TaskState
type CrewmateTranscript = import('../../src/components/tasks/useCrewmateTranscript.ts').CrewmateTranscript
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const overrides: Record<string, unknown> = { sessionId: () => SESSION_ID }
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)
const workspace = (fake as { workspace: () => { originalCwd: string; cwd: string } }).workspace()
const CWD = workspace.originalCwd || workspace.cwd
const HOSTED = { sessionId: SESSION_ID, originalCwd: CWD }
const hostedDir = join(getProjectDir(CWD), SESSION_ID, 'subagents')
const HOSTED_FILE = join(hostedDir, `agent-${HOSTED_WRITER_ID}.jsonl`)
const LOCAL_FILE = getAgentTranscriptPath(asAgentId(LOCAL_WRITER_ID))

const NOW = Date.now()
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stampOf = (n: number): string => new Date(NOW - 300_000 + n * 1000).toISOString()
function seedRow(agentId: string, n: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { isSidechain: true, agentId, entrypoint: 'cli', cwd: process.cwd(), sessionId: SESSION_ID, version: '1.0.0', gitBranch: 'main', parentUuid: n === 0 ? null : uuidOf(n - 1), uuid: uuidOf(n), timestamp: stampOf(n), ...extra }
}
const assistant = (agentId: string, n: number, content: unknown[]): Record<string, unknown> =>
  seedRow(agentId, n, { type: 'assistant', message: { id: `msg_${agentId}_${n}`, type: 'message', role: 'assistant', model: MODEL, content, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
function crewmateRows(agentId: string): Record<string, unknown>[] {
  return [
    seedRow(agentId, 0, { type: 'system', subtype: 'informational', content: 'the crewmate booted on its seat', level: 'info' }),
    seedRow(agentId, 1, { type: 'user', message: { role: 'user', content: `<crewmate-message crewmate_id="crew-lead" summary="the channel design">Research only: read the queued notes, then inspect the repository and name the message boundaries.</crewmate-message>` } }),
    assistant(agentId, 2, [{ type: 'text', text: `${NEEDLE} 1 — the seam: the boundary is the tool result, not the message envelope.` }]),
    assistant(agentId, 3, [{ type: 'tool_use', id: `toolu_${agentId}_1`, name: 'Read', input: { file_path: '/fixture/notes.md', offset: 40 } }]),
    seedRow(agentId, 4, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${agentId}_1`, content: 'the notes: six lines of the owner\'s queue' }] } }),
    assistant(agentId, 5, [{ type: 'text', text: `${NEEDLE} 2 — the notes name six boundaries; the transcript on disk is the record.` }]),
  ]
}
function seedCrewmateFile(file: string, agentId: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(crewmateRows(agentId) as never, SESSION_ID))
  writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'mercury-general', model: MODEL, effort: 'max', instructionProfile: 'auto' }))
}
seedCrewmateFile(HOSTED_FILE, HOSTED_WRITER_ID)
seedCrewmateFile(LOCAL_FILE, LOCAL_WRITER_ID)
check('rig: the hosted fixture file is named by the writer\'s own agent id, never the crew address', HOSTED_FILE.endsWith(`agent-${HOSTED_WRITER_ID}.jsonl`) && !HOSTED_FILE.includes('@'), HOSTED_FILE)
check('rig: the in-process fixture file lies where the transcript writer names it', LOCAL_FILE.endsWith(`agent-${LOCAL_WRITER_ID}.jsonl`), LOCAL_FILE)

const hostedRow = {
  id: ADDRESS,
  agentId: ADDRESS,
  kind: 'crewmate',
  name: NAME,
  status: 'running',
  startTime: NOW - 60_000,
  model: MODEL,
  crew: CREW,
  transcriptAgentId: HOSTED_WRITER_ID,
  inputTokens: 181_500,
  outputTokens: 2_000,
  contextTokens: 181_500,
} as WorkRow
const hostedFacts = crewAgentFactsOf(hostedRow, SESSION_ID)
const hostedCrewmate: CrewmateInView = { taskId: ADDRESS, name: NAME, facts: hostedFacts, local: undefined, pinned: false, running: 1 }

const localTask = {
  ...createTaskStateBase(LOCAL_TASK_ID, 'in_process_crewmate', `${NAME}: research only`),
  type: 'in_process_crewmate',
  status: 'running',
  identity: { agentId: ADDRESS, agentName: NAME, crewName: CREW, parentSessionId: SESSION_ID },
  prompt: 'research only',
  model: MODEL,
  transcriptAgentId: LOCAL_WRITER_ID,
  isIdle: false,
  shutdownRequested: false,
  messages: [],
} as unknown as TaskState
const localRow = projectWorkRoster({ [LOCAL_TASK_ID]: localTask })[0]
const localFacts = localRow === undefined ? null : crewAgentFactsOf(localRow, SESSION_ID)
const localCrewmate: CrewmateInView = { taskId: LOCAL_TASK_ID, name: NAME, facts: localFacts, local: localTask, pinned: false, running: 1 }

section('§1 the file name: a crewmate\'s row carries the id the transcript writer uses, and the view names the file by it')
{
  const factsId = (hostedFacts as (CrewAgentFacts & { transcriptAgentId?: string | null }) | null)?.transcriptAgentId ?? null
  check('the crew facts of a hosted crewmate row carry the writer\'s agent id (transcriptAgentId)', factsId === HOSTED_WRITER_ID, `facts.transcriptAgentId=${String(factsId)}`)
  const projectedId = (localRow as (WorkRow & { transcriptAgentId?: string }) | undefined)?.transcriptAgentId
  check('the roster projection of an in-process crewmate task carries its transcript agent id', projectedId === LOCAL_WRITER_ID, `row.transcriptAgentId=${String(projectedId)} · row=${JSON.stringify(localRow)?.slice(0, 200)}`)
  const hostedResolved = transcript.crewmateTranscriptFile(hostedCrewmate as never, HOSTED)
  console.log(`the hosted crewmate's transcript file resolves to ${String(hostedResolved)}`)
  check(`a hosted crewmate row whose task id is the crew address (${ADDRESS}) resolves to the writer's file agent-${HOSTED_WRITER_ID}.jsonl`, hostedResolved === HOSTED_FILE, `resolved ${String(hostedResolved)} · expected ${HOSTED_FILE}`)
  const localResolved = transcript.crewmateTranscriptFile(localCrewmate as never, HOSTED)
  console.log(`the in-process crewmate's transcript file resolves to ${String(localResolved)}`)
  check(`an in-process crewmate task resolves to the writer's file agent-${LOCAL_WRITER_ID}.jsonl (never null, never the in-memory mirror alone)`, localResolved === LOCAL_FILE, `resolved ${String(localResolved)} · expected ${LOCAL_FILE}`)
  const plainRow = { id: 'a-plain', agentId: 'a-plain', kind: 'agent', name: 'plain', status: 'running', startTime: NOW } as WorkRow
  const plain: CrewmateInView = { taskId: 'a-plain', name: 'plain', facts: crewAgentFactsOf(plainRow, SESSION_ID), local: undefined, pinned: false, running: 1 }
  check('a hosted crewmate row without the field still resolves by its task id (a V1 row reads as today)', transcript.crewmateTranscriptFile(plain as never, HOSTED) === join(hostedDir, 'agent-a-plain.jsonl'))
}

const fileRows = {
  hosted: await transcript.readCrewmateTranscriptFile(HOSTED_FILE, HOSTED_WRITER_ID),
  local: await transcript.readCrewmateTranscriptFile(LOCAL_FILE, LOCAL_WRITER_ID),
}
check(`rig: the reader returns the fixture's rows from the hosted file (${fileRows.hosted.length} rows)`, fileRows.hosted.length >= TEXT_ROWS + TOOL_ROWS + 1, String(fileRows.hosted.length))
check(`rig: the reader returns the fixture's rows from the in-process file (${fileRows.local.length} rows)`, fileRows.local.length === fileRows.hosted.length, String(fileRows.local.length))

const latest = { transcript: null as CrewmateTranscript | null, model: null as { model: string | null; effort: string | null } | null }
function TranscriptProbe({ crewmate }: { crewmate: CrewmateInView }): React.ReactNode {
  const result = transcript.useCrewmateTranscript(crewmate, 0)
  latest.transcript = result
  return h(Text, null, `transcript ${result?.state ?? 'null'} ${result?.messages.length ?? 0}`)
}
function ModelProbe({ crewmate }: { crewmate: CrewmateInView }): React.ReactNode {
  const result = useCrewmateModel(crewmate)
  latest.model = result
  return h(Text, null, `model ${String(result?.model)} effort ${String(result?.effort)}`)
}
async function mount(node: React.ReactNode): Promise<() => Promise<void>> {
  const stdout = new Output(120, 30)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(120, 30) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, node))
  return async () => {
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
  }
}
const textsOf = (rows: readonly unknown[]): string[] => rows.map(row => JSON.stringify((row as { message?: { content?: unknown } }).message?.content ?? '')).filter(text => text.includes(NEEDLE))
const toolUsesOf = (rows: readonly unknown[]): number => rows.filter(row => JSON.stringify((row as { message?: { content?: unknown } }).message?.content ?? '').includes('"tool_use"')).length

async function proveHook(label: string, crewmate: CrewmateInView, expected: readonly unknown[]): Promise<void> {
  latest.transcript = null
  const close = await mount(h(TranscriptProbe, { crewmate }))
  const settled = await until(() => latest.transcript !== null && latest.transcript.state !== 'reading')
  const result = latest.transcript
  console.log(`${label}: state ${String(result?.state)} · ${result?.messages.length ?? 0} rows (the file holds ${expected.length})`)
  check(`${label}: the hook settles on the file (state ready, not empty, not reading)`, settled && result?.state === 'ready', `state ${String(result?.state)} after ${settled ? 'the read' : 'the wait'}`)
  check(`${label}: the hook's rows are the file's rows (${expected.length})`, result !== null && result.messages.length === expected.length, `${result?.messages.length ?? 0} rows`)
  const texts = result === null ? [] : textsOf(result.messages)
  check(`${label}: the crewmate's text replies paint (${TEXT_ROWS} ${NEEDLE} rows)`, texts.length === TEXT_ROWS, texts.join(' | ').slice(0, 200))
  check(`${label}: the crewmate's tool call paints (${TOOL_ROWS} tool-use row)`, result !== null && toolUsesOf(result.messages) === TOOL_ROWS, String(result === null ? 0 : toolUsesOf(result.messages)))
  await close()
}

section('§2 the hook: a crewmate\'s rows are the file\'s rows, hosted and in-process alike')
await proveHook('hosted crewmate', hostedCrewmate, fileRows.hosted)
await proveHook('in-process crewmate', localCrewmate, fileRows.local)

section('§3 the strip: the crewmate\'s model and effort read from the sidecar beside that file, else the row\'s own word')
async function proveModel(label: string, crewmate: CrewmateInView, effort: string): Promise<void> {
  latest.model = null
  const close = await mount(h(ModelProbe, { crewmate }))
  const settled = await until(() => latest.model?.effort === effort, 4000)
  console.log(`${label}: model ${String(latest.model?.model)} · effort ${String(latest.model?.effort)}`)
  check(`${label}: the strip reads the crewmate's effort (${effort}), never "effort unreported"`, settled, `effort ${String(latest.model?.effort)}`)
  check(`${label}: the strip names the crewmate's model (${MODEL})`, latest.model?.model === MODEL, String(latest.model?.model))
  await close()
}
await proveModel('hosted crewmate (sidecar)', hostedCrewmate, 'max')
await proveModel('in-process crewmate (sidecar)', localCrewmate, 'max')
{
  const wordRow = { ...hostedRow, id: `${NAME}-2@${CREW}`, agentId: `${NAME}-2@${CREW}`, name: `${NAME}-2`, transcriptAgentId: 'a0nosidecar', effort: 'max' } as WorkRow
  const wordCrewmate: CrewmateInView = { taskId: wordRow.id, name: wordRow.name, facts: crewAgentFactsOf(wordRow, SESSION_ID), local: undefined, pinned: false, running: 1 }
  await proveModel('hosted crewmate (no sidecar yet, the row carries the word)', wordCrewmate, 'max')
}

console.error = originalError
clearTimeout(deadline)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 500))
rmSync(HOME, { recursive: true, force: true })
console.log(`\ncrewmate-transcript: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
