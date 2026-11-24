#!/usr/bin/env bun
import { plugin } from 'bun'
import { mock } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const runnerAt = process.argv.indexOf('--runner')
const RUNNER = runnerAt !== -1
const scratch = RUNNER ? process.argv[runnerAt + 1]! : realpathSync(mkdtempSync(join(tmpdir(), 'cd-lasts-')))
const project = join(scratch, 'project')
const sub = join(project, 'sub')
const deep = join(project, 'deep')
const bare = join(project, 'bare')
const outside = join(scratch, 'outside')
const marked = join(project, 'q checkpoint="c9" fallback="root"')
const broken = join(project, 'two\nlines')
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const name of ['MERCURY_HOME', 'MERCURY_BARE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT', 'MERCURY_SCRIPTED_STREAM', 'NODE_ENV']) delete process.env[name]
if (!(process.env.SHELL ?? '').includes('bash') && existsSync('/bin/bash')) process.env.SHELL = '/bin/bash'

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (...args: string[]): string => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: gitEnv }).trim()
if (!RUNNER) {
  for (const dir of [sub, deep, outside, join(scratch, 'home')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(sub, 'keep.txt'), 'kept\n')
  writeFileSync(join(deep, 'keep.txt'), 'kept\n')
  writeFileSync(join(project, 'notes.txt'), 'the notes of the project\n')
  writeFileSync(join(outside, 'notes.txt'), 'the notes of the folder outside\n')
  writeFileSync(join(project, '.gitignore'), '.mercury/\nbare/\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'first')
  for (const dir of [join(bare, 'objects'), join(bare, 'refs'), marked, broken]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n')
}

const realQuery = await import('../../src/engine/turnDoor.ts')
const realQueryEvents = realQuery.turnDoorEvents
let scripted: Record<string, unknown> | null = null
mock.module('../../src/engine/turnDoor.ts', () => ({
  ...realQuery,
  turnDoorEvents: async function* (params: Record<string, unknown>): AsyncGenerator<unknown, unknown> {
    return yield* realQueryEvents((scripted === null ? params : { ...params, deps: scripted }) as never)
  },
}))

const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { exec, setCwd, getShellCwd } = await import('../../src/platform/shell/shellExec.ts')
const { getCwd, runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
const { ask } = await import('../../src/engine/rows/turn.ts')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.ts')
const { hasPermissionsToUseTool } = await import('../../src/permissions/rules/permissionDoor.ts')
const { BashTool } = await import('../../src/tools/shell/BashTool.tsx')
const { CheckpointTool } = await import('../../src/tools/checkpoint/CheckpointTool.tsx')
const { RewindTool } = await import('../../src/tools/rewind/RewindTool.tsx')
const { EnterWorktreeTool } = await import('../../src/tools/enter-worktree/EnterWorktreeTool.ts')
const { ExitWorktreeTool } = await import('../../src/tools/exit-worktree/ExitWorktreeTool.ts')

process.chdir(project)
setCwd(project)
bootstrap.setOriginalCwd(project)

type Step = { name: string; input: Record<string, unknown> }
type Ran = { tool: string; input: Record<string, unknown>; status: string; output: string }
type Verdict = { command: string; behavior: string; message: string }
const MODEL = 'claude-opus-4-8'
const TOOLS = [BashTool, CheckpointTool, RewindTool, EnterWorktreeTool, ExitWorktreeTool]
const bash = (command: string): Step => ({ name: 'Bash', input: { command, description: 'a step of the proof' } })
const firstLine = (ran: Ran | undefined): string => (ran?.output ?? '').split('\n')[0]!.trim()

const messages: Array<Record<string, unknown>> = []
const verdicts: Verdict[] = []
let appState = { ...getDefaultAppState(), effortValue: 'high' } as ReturnType<typeof getDefaultAppState>
let readFiles = createFileStateCacheWithSizeLimit(100)

async function gateThenYes(tool: { name: string }, input: Record<string, unknown>, context: unknown, assistantMessage: unknown, toolUseID: string): Promise<unknown> {
  const decision = (await hasPermissionsToUseTool(tool as never, input, context as never, assistantMessage as never, toolUseID)) as { behavior: string; message?: string }
  if (tool.name === 'Bash') verdicts.push({ command: String(input.command), behavior: decision.behavior, message: decision.message ?? '' })
  return decision.behavior === 'allow' ? decision : { behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'the proof answers yes' } }
}

async function turn(steps: Step[]): Promise<{ uuid: string; ran: Ran[] }> {
  let asked = 0
  scripted = {
    callModel: async function* (): AsyncGenerator<unknown, void> {
      const step = steps[asked++]
      const reply = createAssistantMessage({ content: step === undefined ? 'done' : ([{ type: 'tool_use', id: `tu_${randomUUID()}`, name: step.name, input: step.input }] as never) })
      reply.message.stop_reason = step === undefined ? 'end_turn' : 'tool_use'
      yield reply
    },
    autoFold: async () => ({ wasCompacted: false }),
    prune: async (rows: unknown[]) => ({ messages: rows }),
    uuid: () => randomUUID(),
  }
  const uuid = randomUUID()
  const open = new Map<string, Ran>()
  const ran: Ran[] = []
  try {
    for await (const row of ask({
      prompt: 'run the scripted steps',
      promptUuid: uuid,
      cwd: getCwd(),
      tools: TOOLS as never,
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: gateThenYes as never,
      getAppState: () => appState,
      setAppState: update => {
        appState = update(appState)
      },
      mutableMessages: messages as never,
      getReadFileCache: () => readFiles,
      setReadFileCache: cache => {
        readFiles = cache
      },
      userSpecifiedModel: MODEL,
    })) {
      const seen = row as { type?: string; call_id?: string; tool?: string; input?: Record<string, unknown>; status?: string; output?: string }
      if (seen.call_id === undefined) continue
      if (seen.type === 'tool_call') {
        const call: Ran = { tool: seen.tool ?? '', input: seen.input ?? {}, status: 'open', output: '' }
        open.set(seen.call_id, call)
        ran.push(call)
      }
      const call = open.get(seen.call_id)
      if (seen.type === 'tool_result' && call !== undefined) Object.assign(call, { status: seen.status ?? '', output: seen.output ?? '' })
    }
  } finally {
    scripted = null
  }
  return { uuid, ran }
}

const { resolveShellEngine, endEngineSession } = await import('../../src/platform/shell/engineSession.ts')
if (RUNNER) {
  const ran: string[] = []
  for (const command of process.argv.slice(runnerAt + 2)) ran.push(firstLine((await turn([bash(command)])).ran[0]))
  const report = { ran, shell: getShellCwd(), session: getCwd(), engine: resolveShellEngine().engine }
  await endEngineSession()
  console.log(JSON.stringify(report))
  process.exit(0)
}

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}
const fix = (hint: string, detail?: unknown): string => (detail === undefined ? hint : `${typeof detail === 'string' ? detail : JSON.stringify(detail)} — ${hint}`)
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — prove-cd-lasts-the-session ran past 240 s; a scripted Bash turn or a runner child never finished, so read the last section header above and the command it ran (exec in src/platform/shell/shellExec.ts)')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

const { getFoldUserSummaryMessage } = await import('../../src/engine/compaction/summariserPrompt.ts')
const { createOperatorRewindRecordMessage, createRewindRecordMessage, projectRewoundWindows } = await import('../../src/engine/compaction/checkpointRewind.ts')
const { handleRewindSession } = await import('../../src/daemon/runner/controlHandlers.ts')
const sentence = (directory: string): string => `The shell's working directory is still where an earlier cd left it: ${directory}`
const frame = (): string => getFoldUserSummaryMessage('<summary>the earlier stretch</summary>', false, join(scratch, 'session.jsonl'), true)
const textOf = (row: Record<string, unknown> | undefined): string => String((row?.message as { content?: unknown } | undefined)?.content ?? '')
const lastRewindRecord = (): string => textOf(messages.findLast(row => textOf(row).startsWith('<mercury-rewind-record')))
const modelRecordToday = (id: string, removed: number, report: string): string =>
  [`<mercury-rewind-record checkpoint="${id}">`, 'The conversation was rewound to the checkpoint (goal: look around).', `${removed} message(s) of abandoned exploration were removed from the model context (the operator's transcript keeps them).`, 'Report carried back from the exploration:', report, '</mercury-rewind-record>'].join('\n')
const operatorRecordToday = (uuid: string, removed: number): string =>
  [`<mercury-rewind-record turn="${uuid}" by="operator">`, `The operator wound the conversation back to before this turn; ${removed} message(s) left the model's view (the transcript keeps them).`, '</mercury-rewind-record>'].join('\n')
const removedOf = (record: string): number => Number(/(\d+) message\(s\)/.exec(record)?.[1] ?? Number.NaN)
const checkpointOf = (record: string): string => /checkpoint="([^"]+)"/.exec(record)?.[1] ?? ''
const rewind = async (uuid: string): Promise<string> => {
  const receipt = await handleRewindSession({ user_message_id: uuid, mode: 'conversation' } as never, { messages: messages as never, getAppState: () => appState, drift: { get: () => undefined } as never, turnActive: false })
  return receipt.outcome
}
type Runner = { status: number | null; ran: string[]; shell?: string; session?: string; engine?: string; stderr?: string }
function runner(commands: string[], env: Record<string, string> = {}): Runner {
  const child = spawnSync(process.execPath, [import.meta.path, '--runner', scratch, ...commands], { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 })
  const line = (child.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    return { ...(JSON.parse(line) as Runner), status: child.status }
  } catch {
    return { status: child.status, ran: [], stderr: `${line} ${(child.stderr ?? '').slice(-400)}` }
  }
}
const inView = (): string => projectRewoundWindows(messages as never).map(row => (row as { uuid: string }).uuid).join(' ')
const step = async (command: string): Promise<void> => {
  const ran = await exec(command, new AbortController().signal, 'bash', { timeout: 20_000 })
  await ran.result
  ran.cleanup()
}
const explore = (command: string, report: string): Step[] => [{ name: 'Checkpoint', input: { goal: 'look around' } }, bash(command), { name: 'Rewind', input: { report } }]

console.log('============================================================')
console.log(' A cd in the Bash tool lasts the session')
console.log('============================================================')

section('§1 a session that never left its folder: every rebuilt view reads as it did')
const frameAtHome = frame()
{
  const first = await turn([bash('pwd')])
  check('the first command of the session runs in the session folder', firstLine(first.ran[0]) === project && getShellCwd() === project, fix('getShellCwd in src/platform/shell/shellExec.ts must fall back to the session folder when no cd has run', first.ran))
  check('the frame of a fold says nothing of the shell', !frameAtHome.includes("shell's working directory"), fix('getCompactUserSummaryMessage in src/engine/compaction/summariserPrompt.ts must add the shell sentence only when shellDirectoryLeftByCd (src/platform/files/cwd.ts) returns a folder', frameAtHome))
  const explored = await turn(explore('pwd', 'nothing moved'))
  const record = lastRewindRecord()
  check("the model's own rewind writes its record byte for byte as today", explored.ran.length === 3 && record === modelRecordToday(checkpointOf(record), removedOf(record), 'nothing moved'), fix('createRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must leave the record unchanged when the shell never left the session folder', record))
  const outcome = await rewind(explored.uuid)
  const operatorRecord = lastRewindRecord()
  check("the operator's rewind writes its record byte for byte as today", outcome === 'applied' && operatorRecord === operatorRecordToday(explored.uuid, removedOf(operatorRecord)), fix('createOperatorRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must leave the record unchanged when the shell never left the session folder', { outcome, operatorRecord }))
}

section('§2 two openings of a turn: a cd in the first, a command in the second')
const moved = await turn([bash('cd sub')])
const next = await turn([bash('pwd')])
check('the cd of the first turn ran and was allowed', moved.ran[0]?.status === 'ok', fix('the Bash tool refused or failed a plain cd; run it by hand and read the gate verdict in src/tools/shell', moved.ran))
check('the command of the second turn runs in sub', firstLine(next.ran[0]) === sub, `it ran in ${JSON.stringify(firstLine(next.ran[0]))}, sub is ${sub} — a cd must persist in the shell folder kept by src/platform/shell/shellExec.ts (getShellCwd) across turns`)
check('the shell folder is sub and the session folder stays', getShellCwd() === sub && getCwd() === project, fix('a cd must move only the shell folder (getShellCwd in src/platform/shell/shellExec.ts), never the session folder (getCwd in src/platform/files/cwd.ts)', { shell: getShellCwd(), session: getCwd() }))
const third = await turn([bash('cd ../deep'), bash('pwd')])
const fourth = await turn([bash('pwd')])
check('a second cd, relative to the first, lasts into the next turn too', firstLine(third.ran[1]) === deep && firstLine(fourth.ran[0]) === deep, fix('a relative cd must resolve from the shell folder that the last cd left, kept by src/platform/shell/shellExec.ts (getShellCwd)', { third: third.ran.map(firstLine), fourth: fourth.ran.map(firstLine) }))
{
  const here = resolveShellEngine().engine
  const other = here === 'brush' ? 'system' : 'brush'
  const road = runner(['cd sub', 'pwd'], { MERCURY_SHELL_ENGINE: other })
  console.log(`        note: this process runs its commands on the ${here} road`)
  if (road.engine === other) check(`on the ${other} road, in a runner of its own, the command of the second turn runs in sub`, road.status === 0 && road.ran[1] === sub && road.shell === sub && road.session === project, fix('the cd must persist on this shell road too; compare how src/platform/shell/shellExec.ts (exec) records the folder after the command on each engine', road))
  else console.log(`  [INFO] the ${other} road did not run here: the shell engine answered ${JSON.stringify(road.engine ?? road.stderr)}`)
}

section('§3 /clear: the runner it starts has a shell in the session folder')
{
  const fresh = runner(['pwd'])
  check('the old runner still stands where its cd left it', getShellCwd() === deep, fix('the first runner lost its cd; getShellCwd in src/platform/shell/shellExec.ts must keep the folder a cd left', getShellCwd()))
  check('a runner started on the same home and the same folder runs its first command in the session folder', fresh.status === 0 && fresh.ran[0] === project && fresh.shell === project && fresh.session === project, fix('a new runner must start its shell in the session folder; check the shell folder state in src/platform/shell/shellExec.ts (shellCwd, getShellCwd) is not shared across runners', fresh))
}

section('§4 a rewind past a cd names the folder the shell stands in')
{
  const explored = await turn(explore(`cd ${sub}`, 'the cd is behind the rewind'))
  const record = lastRewindRecord()
  const lines = record.split('\n')
  check("the model's own rewind carries the sentence, before its report", lines[3] === sentence(sub) && lines[4] === 'Report carried back from the exploration:', fix('createRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must insert shellDirectoryLeftByCd (src/platform/files/cwd.ts) before the report line', record))
  check('without that line the record is the record of today', explored.ran.length === 3 && lines.filter((_, index) => index !== 3).join('\n') === modelRecordToday(checkpointOf(record), removedOf(record), 'the cd is behind the rewind'), fix('createRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must differ from the record of today only by the shell sentence', record))
  check('a record made by hand reads the same', createRewindRecordMessage({ checkpointId: 'c1', goal: 'look around', report: 'r', abandonedMessageCount: 2, rootFallback: false }).message.content === [...modelRecordToday('c1', 2, 'r').split('\n').slice(0, 3), sentence(sub), ...modelRecordToday('c1', 2, 'r').split('\n').slice(3)].join('\n'), 'createRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must place the shell sentence after the removed-messages line and before the report line')
  const outcome = await rewind(moved.uuid)
  const operatorRecord = lastRewindRecord()
  const operatorLines = operatorRecord.split('\n')
  check("the operator's rewind to before the first cd carries the sentence", outcome === 'applied' && operatorLines.length === 4 && operatorLines[2] === sentence(sub), fix('createOperatorRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must carry shellDirectoryLeftByCd (src/platform/files/cwd.ts) and the rewind must apply', { outcome, operatorRecord }))
  check('without that line the record is the record of today', operatorLines.filter((_, index) => index !== 2).join('\n') === operatorRecordToday(moved.uuid, removedOf(operatorRecord)), fix('createOperatorRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must differ from the record of today only by the shell sentence', operatorRecord))
  check('a record made by hand reads the same', createOperatorRewindRecordMessage({ turnUuid: 't1', removed: 4 }).message.content === [...operatorRecordToday('t1', 4).split('\n').slice(0, 2), sentence(sub), '</mercury-rewind-record>'].join('\n'), 'createOperatorRewindRecordMessage in src/engine/compaction/checkpointRewind.ts must place the shell sentence on the third line, before the closing tag')
  const after = await turn([bash('pwd')])
  check('the shell is where the sentence says, in the turn after the rewind', firstLine(after.ran[0]) === sub, fix('a rewind must not reset the shell folder; check shellCwd in src/platform/shell/shellExec.ts and handleRewindSession in src/daemon/runner/controlHandlers.ts', after.ran))
  const viewBefore = inView()
  const strayed = await turn([bash(`cd '${marked}'`)])
  const strayedOutcome = await rewind(strayed.uuid)
  const strayedRecord = lastRewindRecord()
  check('a folder whose name holds the marks of a record is written as a JSON string', strayed.ran[0]?.status === 'ok' && strayedOutcome === 'applied' && strayedRecord.split('\n')[2] === sentence(JSON.stringify(marked)), fix('shellDirectoryLeftByCd in src/platform/files/cwd.ts must JSON-quote a folder name that holds a quote or control character', { ran: strayed.ran, strayedRecord }))
  check('and the rows left in view are the rows from before that turn', inView() === viewBefore, fix('projectRewoundWindows in src/engine/compaction/checkpointRewind.ts must keep exactly the rows from before the rewound turn', { before: viewBefore.split(' ').length, after: inView().split(' ').length }))
  await turn([bash(`cd '${sub}'`)])
}

section('§5 a fold names the folder the shell stands in')
{
  const framed = frame()
  const paragraphs = framed.split('\n\n')
  const at = paragraphs.indexOf(sentence(sub))
  check('the frame carries the sentence with the folder', at !== -1, fix('getCompactUserSummaryMessage in src/engine/compaction/summariserPrompt.ts must push shellDirectoryLeftByCd (src/platform/files/cwd.ts) while the shell stands outside the session folder', framed))
  check('it stands after the transcript sentence and before the tail sentence', at > 0 && paragraphs[at - 1]!.endsWith(join(scratch, 'session.jsonl')) && paragraphs[at + 1] === 'The most recent messages of the conversation are preserved verbatim after this summary.', fix('getCompactUserSummaryMessage in src/engine/compaction/summariserPrompt.ts must push the shell sentence after the transcript paragraph and before the preserved-messages paragraph', paragraphs))
  check('the sentence is the whole difference from the frame of a session that never left', paragraphs.filter((_, index) => index !== at).join('\n\n') === frameAtHome, fix('getCompactUserSummaryMessage in src/engine/compaction/summariserPrompt.ts must add nothing but the shell sentence', framed))
  check('a crewmate, whose own shell never moved, reads the frame and the record of a session that never left', runWithCwdOverride(deep, () => frame() === frameAtHome && textOf(createOperatorRewindRecordMessage({ turnUuid: 't1', removed: 4 }) as never) === operatorRecordToday('t1', 4)), 'shellCwdLeftByCd in src/platform/shell/shellExec.ts must read the crewmate own shell folder under runWithCwdOverride, not the lead shell folder')
  await step(`cd "${broken}"`)
  check('a folder whose name holds a line break stays one paragraph, as a JSON string', getShellCwd() === broken && frame().split('\n\n').includes(sentence(JSON.stringify(broken))), fix('shellDirectoryLeftByCd in src/platform/files/cwd.ts must JSON-quote a folder name with a line break', { shell: getShellCwd(), frame: frame() }))
  await step(`cd "${sub}"`)
  const { foldConversation, buildPostFoldMessages } = await import('../../src/engine/compaction/foldConversation.ts')
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'The earlier stretch moved the shell and looked around. Carry on from the newest request of the operator.' })))
  process.env.ANTHROPIC_BASE_URL = api.url
  const foldContext = { abortController: new AbortController(), getAppState: () => appState, setAppState: () => {}, messages: [], readFileState: new Map(), options: { tools: [], mcpClients: [], engineModel: MODEL, thinkingConfig: { type: 'adaptive' }, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [] } } }
  const folded = await foldConversation(messages as never, foldContext as never, { systemPrompt: ['the posture of the proof'] } as never, true)
  await api.close()
  const summary = textOf(folded.summaryMessages[0] as never)
  check('a fold of this conversation writes the sentence into the summary the model reads', summary.split('\n\n').includes(sentence(sub)), fix('compactConversation in src/engine/compaction/foldConversation.ts must build its summary message with getCompactUserSummaryMessage (src/engine/compaction/summariserPrompt.ts)', summary.slice(0, 900)))
  messages.splice(0, messages.length, ...(buildPostFoldMessages(folded) as never[]))
  const after = await turn([bash('pwd')])
  check('the command after the fold runs where the summary says', firstLine(after.ran[0]) === sub, fix('after a fold the shell must stay in the folder the summary names; check that compaction does not reset shellCwd in src/platform/shell/shellExec.ts', after.ran))
}

section('§6 the gates judge a later turn in the folder its command runs in')
{
  await turn([bash(`cd ${outside}`)])
  verdicts.length = 0
  const read = await turn([bash('cat notes.txt')])
  const readVerdict = verdicts.find(row => row.command === 'cat notes.txt')
  check('a relative read runs in the folder outside', firstLine(read.ran[0]) === 'the notes of the folder outside', fix('the shell must run the second turn in the folder the cd left (getShellCwd in src/platform/shell/shellExec.ts)', read.ran))
  check('the path constraints judged it there: a read outside the session folder asks', readVerdict?.behavior === 'ask' && readVerdict.message.includes(outside), fix('the Bash path constraints must resolve a relative path against the shell folder, not the session folder', readVerdict))
  await turn([bash(`cd ${bare}`)])
  verdicts.length = 0
  const status = await turn([bash('git status')])
  const gitVerdict = verdicts.find(row => row.command === 'git status')
  check('the read-only verdict and git safety judged git there: a folder with the structure of a bare repository asks', gitVerdict !== undefined && gitVerdict.behavior !== 'allow' && /bare-repository structure/.test(gitVerdict.message), fix('checkReadOnlyConstraints in src/tools/shell/readOnlyValidation.ts must judge git in the folder the shell stands in; isCurrentDirectoryBareGitRepo is in src/platform/git/git.ts', { gitVerdict, status: status.ran }))
  await turn([bash(`cd ${project}`)])
  verdicts.length = 0
  await turn([bash('cat notes.txt'), bash('git status')])
  check('back in the session folder the same two commands are allowed', verdicts.length === 2 && verdicts.every(row => row.behavior === 'allow'), fix('the Bash gates must judge these two commands in the session folder once the shell is back there', verdicts))
}

section('§7 a worktree switch moves the session folder, and the shell goes with it')
{
  const lane = join(project, '.mercury', 'worktrees', 'cd-lane')
  const entered = await turn([bash('cd sub'), bash('pwd'), { name: 'EnterWorktree', input: { name: 'cd-lane' } }, bash('pwd')])
  check('the shell stood in sub before the switch', firstLine(entered.ran[1]) === sub, fix('a cd must persist across commands of one turn; see getShellCwd in src/platform/shell/shellExec.ts', entered.ran))
  check('the first command after the switch runs in the worktree, not in sub', entered.ran[2]?.status === 'ok' && firstLine(entered.ran[3]) === lane && getCwd() === lane, fix('EnterWorktree (src/tools/enter-worktree/EnterWorktreeTool.ts) calls setCwd, and the cwd subscriber in src/platform/shell/shellExec.ts must then reset the shell folder to the worktree', entered.ran))
  await turn([bash('cd sub')])
  const inside = await turn([bash('pwd')])
  check('a cd inside the worktree lasts into the next turn', firstLine(inside.ran[0]) === join(lane, 'sub'), fix('a cd inside the worktree must persist; see shellCwd in src/platform/shell/shellExec.ts', inside.ran))
  const left = await turn([{ name: 'ExitWorktree', input: { action: 'keep' } }, bash('pwd')])
  check('the first command after the exit runs in the checkout, not in the sub of the worktree', left.ran[0]?.status === 'ok' && firstLine(left.ran[1]) === project && getCwd() === project, fix('ExitWorktree (src/tools/exit-worktree/ExitWorktreeTool.ts) calls setCwd, and the cwd subscriber in src/platform/shell/shellExec.ts must then reset the shell folder to the checkout', left.ran))
  check('the frame of a fold is back to the frame of a session that never left', frame() === frameAtHome, 'after ExitWorktree the shell folder must equal the session folder again, so shellCwdLeftByCd in src/platform/shell/shellExec.ts returns null')
}

section('§8 one folder spelled two ways is one folder where the platform folds the case of a path')
{
  const shouted = project.toUpperCase()
  if (!existsSync(shouted)) console.log('  [INFO] this volume holds the case of a name apart, so the row did not run here')
  else {
    bootstrap.setCwdState(shouted)
    await step('true')
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const folded = frame()
    Object.defineProperty(process, 'platform', platform)
    check('the shell stands in the session folder under its other spelling, and the frame says nothing of a cd', getShellCwd() === project && getCwd() === shouted && folded === frameAtHome, fix('shellCwdLeftByCd in src/platform/shell/shellExec.ts compares folders with normalizePathForComparison; it must treat two case spellings as one folder on win32', { shell: getShellCwd(), session: getCwd(), folded }))
    setCwd(project)
  }
}

process.chdir(tmpdir())
rmSync(scratch, { recursive: true, force: true })
console.log('\n============================================================')
console.log(failures === 0 ? ` ✅ prove-cd-lasts-the-session: all ${checks} checks pass` : ` ❌ prove-cd-lasts-the-session: ${failures} of ${checks} checks FAILED`)
console.log('============================================================')
process.exit(failures === 0 ? 0 : 1)
