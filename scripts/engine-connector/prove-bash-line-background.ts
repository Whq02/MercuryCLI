#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const NODE = (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bash-line-background-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
const MARK = `bang-${process.pid}`
const COMMAND = `sleep 400 # ${MARK}`

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of ['MERCURY_HOME', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'NODE_ENV']) delete process.env[k]
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9'

spawnSync('git', ['-C', work, 'init', '-q'])
writeFileSync(join(work, 'README.md'), 'x\n')
spawnSync('git', ['-C', work, '-c', 'user.name=p', '-c', 'user.email=p@x.invalid', 'add', 'README.md'])
spawnSync('git', ['-C', work, '-c', 'user.name=p', '-c', 'user.email=p@x.invalid', 'commit', '-q', '-m', 'x'])
process.chdir(work)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(pred: () => Promise<boolean> | boolean, ms: number, stepMs = 150): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      void 0
    }
    await sleep(stepMs)
  }
  return false
}
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
const sleepPids = (): number[] => {
  const table = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? ''
  const pids: number[] = []
  for (const line of table.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m !== null && /^sleep 400\b/.test(m[2]!)) pids.push(Number(m[1]))
  }
  return pids
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const env = {
  ...process.env,
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_PERMISSION_MODE: 'sovereign',
  MERCURY_OPERATOR: 'sam',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  OPENAI_API_KEY: '',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_WARM_RUNNER: '0',
  MERCURY_DAEMON_OWNER_PID: String(process.pid),
}
const log = join(SCRATCH, 'daemon.log')
const daemon = spawn(NODE, [DIST, 'daemon', 'run', work], { cwd: work, env, stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')] })

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const seat = await import('../../src/services/engine-connector/daemonConnector.ts')
const slot = await import('../../src/services/engine-connector/focusedConnector.ts')
const shell = await import('../../src/services/engine-connector/shellRunning.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')
const { endingWorkWords } = await import('../../src/tools/MonitorTool/watchReceipts.ts')
const { bashExitWords } = await import('../../src/components/messages/UserBashOutputMessage.tsx')
const exitWordsOf = (code: string | null, durationMs: string | null, backgroundTaskId: string | null): string | null =>
  typeof bashExitWords === 'function' ? bashExitWords(code, durationMs, backgroundTaskId) : null
const shellFacts = shell as { foregroundShellInRoster?: (rows: ReadonlyArray<{ kind: string; status: string; foreground?: true }>) => boolean }
const foregroundShellInRoster = (rows: ReadonlyArray<{ kind: string; status: string; foreground?: true }>): boolean =>
  typeof shellFacts.foregroundShellInRoster === 'function' ? shellFacts.foregroundShellInRoster(rows) : false
const { BASH_BACKGROUND_TASK_TAG, BASH_INPUT_TAG } = await import('../../src/constants/xml.ts')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
type WorkRow = { id: string; kind: string; name: string; status: string; command?: string; toolUseId?: string; foreground?: true; description?: string; outputFile?: string }
type Facts = { busy?: boolean; work?: WorkRow[] }

const hello = async (): Promise<number | null> => {
  try {
    const r = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, { timeoutMs: 2000, protoRetry: false })) as { ok?: boolean; pid?: number }
    return r.ok ? (r.pid ?? null) : null
  } catch {
    return null
  }
}
const facts = (sid: string): Facts | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as Facts
  } catch {
    return undefined
  }
}
const recOf = (sid: string) => Object.values(sup.readSessionWorkers(daemonDir)).find(r => r.sessionId === sid && r.endedAt === undefined)
const transcriptText = (sid: string): string => {
  const file = join(paths.getProjectDir(work), `${sid}.jsonl`)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}
const textOf = (row: { message?: { content?: unknown } }): string => {
  const c = row.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('')
  return ''
}

let sid = ''
let runnerPid = 0
try {
  section('§0 the pure fact: a shell row that holds the turn is a foreground shell; a backgrounded or finished one is not')
  const rows = (foreground: boolean, status = 'running'): WorkRow[] => [{ id: 't1', kind: 'shell', name: 'sleep', status, ...(foreground ? { foreground: true as const } : {}) }]
  check('a running shell row stamped foreground reads as a running shell', foregroundShellInRoster(rows(true)))
  check('a running shell row without the stamp (already in the background) does not', !foregroundShellInRoster(rows(false)))
  check('a finished foreground row does not', !foregroundShellInRoster(rows(true, 'completed')))
  check('a monitor row never does', !foregroundShellInRoster([{ id: 'm', kind: 'monitor', name: 'w', status: 'running', foreground: true }]))
  const projected = projectWorkRoster({
    fg: { id: 'fg', type: 'local_bash', status: 'running', startTime: 1, description: 'sleep', command: 'sleep 1', isBackgrounded: false, shellCommand: {}, outputFile: '/dev/null' },
    bg: { id: 'bg', type: 'local_bash', status: 'running', startTime: 2, description: 'sleep', command: 'sleep 1', isBackgrounded: true, shellCommand: {}, outputFile: '/dev/null' },
    done: { id: 'done', type: 'local_bash', status: 'completed', startTime: 3, description: 'sleep', command: 'sleep 1', isBackgrounded: false, shellCommand: {}, outputFile: '/dev/null' },
  } as never)
  const byId = new Map(projected.map(r => [r.id, r]))
  check('the roster stamps foreground on the running shell task that is not backgrounded, and on nothing else', byId.get('fg')?.foreground === true && byId.get('bg')?.foreground === undefined && byId.get('done')?.foreground === undefined, JSON.stringify(projected))
  check('the output row words: a background task id outranks the exit words; a plain exit reads as before', exitWordsOf(null, null, 'b7') === 'moved to the background as task b7 — see /runs' && exitWordsOf('0', '12', null) === 'exit 0 · 12ms' && exitWordsOf(null, null, null) === null, String(exitWordsOf(null, null, 'b7')))

  section('§1 a hosted chat runs a `!` line: the chat is in flight, the roster names the shell as the foreground one, and the key stands armed')
  check('the daemon serves', await untilAsync(async () => (await hello()) === daemon.pid, 60_000))
  const born = (await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'sovereign', by: 'operator', bornBlank: true } as never, { timeoutMs: 60_000 })) as { ok: boolean; sessionId?: string; runnerId?: string }
  sid = born.sessionId ?? ''
  check('a blank chat is born', born.ok && sid !== '', JSON.stringify(born))
  const rec = recOf(sid)
  runnerPid = rec?.pid ?? 0
  const connector = await seat.focusDaemonSession({
    sessionId: sid,
    runnerId: rec?.runnerId ?? born.runnerId ?? 'concourse-w1',
    title: 'bang',
    projectLabel: basename(work),
    workspaceId: work,
    home: paths.getProjectDir(work),
    modelKey: 'claude-sonnet-5',
  })
  check('the connector holds the focused slot', slot.getFocusedSessionConnector() === connector)
  check('before the line: no shell runs, the key is down', !shell.focusedShellRunning() && !connector.turnActive())
  const sent = await connector.sendWords(COMMAND, { mode: 'bash' })
  check('the `!` line is delivered through the chat\'s own send door', sent.state === 'accepted' || sent.state === 'delivered' || sent.state === 'queued', JSON.stringify(sent))
  check('the chat paints the line as a `!` row at once', connector.records().some(r => textOf(r as never).includes(`<${BASH_INPUT_TAG}>${COMMAND}</${BASH_INPUT_TAG}>`)), JSON.stringify(connector.records().map(r => textOf(r as never))))
  check('the runner\'s facts say busy: the shell holds the turn', await untilAsync(() => facts(sid)?.busy === true, 20_000), JSON.stringify(facts(sid)))
  const shellRow = (): WorkRow | undefined => (facts(sid)?.work ?? []).find(r => r.kind === 'shell' && (r.command ?? '').includes(MARK))
  check('the roster lists the shell as running and FOREGROUND (the command holds the turn)', await untilAsync(() => shellRow()?.status === 'running' && shellRow()?.foreground === true, 20_000), JSON.stringify(facts(sid)?.work))
  const taskId = shellRow()?.id ?? ''
  check('the screen\'s turn is in flight (the chat is working)', await untilAsync(() => connector.turnActive(), 10_000))
  check('the chat\'s roster snapshot carries the foreground shell', await untilAsync(() => connector.workRoster().rows.some(r => r.kind === 'shell' && r.status === 'running' && r.foreground === true), 10_000), JSON.stringify(connector.workRoster().rows))
  check('THE KEY STANDS ARMED: focusedShellRunning reads the operator\'s own `!` shell (no assistant Bash tool_use row exists for it)', shell.focusedShellRunning(), JSON.stringify({ live: connector.live(), rows: connector.workRoster().rows }))
  check('the ready line names the background key while the shell runs', (await import('../../src/components/SwitchboardTagBar.tsx')).escBackHint(connector.live(), { interrupting: false, hardStopping: false }, shell.focusedShellRunning()).includes('backgrounds'))
  const sleeping = sleepPids()
  check('the sleep itself runs under the runner', sleeping.length >= 1, JSON.stringify(sleeping))

  section('§2 the key\'s road: the shell moves to the background, the turn ends NOW, the row says so, the key stands down')
  const t0 = Date.now()
  const receipt = await connector.backgroundShell()
  check('the chord\'s verb is applied: the runner took the command', receipt.outcome === 'applied' && (receipt.detail ?? '').includes('"taken":1'), JSON.stringify(receipt))
  const turnEnded = await untilAsync(() => facts(sid)?.busy === false && !connector.turnActive(), 15_000)
  const endedAfterMs = Date.now() - t0
  check(`the turn ends within seconds of the key, not when the sleep ends (${endedAfterMs} ms)`, turnEnded && endedAfterMs < 15_000, JSON.stringify({ busy: facts(sid)?.busy, turnActive: connector.turnActive(), live: connector.live() }))
  check('the roster keeps the shell as running, no longer foreground: the chat\'s background work', await untilAsync(() => shellRow()?.status === 'running' && shellRow()?.foreground === undefined, 10_000), JSON.stringify(shellRow()))
  check('the key stands down once the shell is in the background', await untilAsync(() => !shell.focusedShellRunning(), 10_000))
  check('the sleep still runs: nothing was killed by the move', sleepPids().length >= 1 && sleepPids().every(isAlive), JSON.stringify(sleepPids()))
  const outputRow = (): string | undefined => transcriptText(sid).split('\n').find(l => l.includes(`<${BASH_BACKGROUND_TASK_TAG}>`))
  check('the transcript\'s output row records the move: the background task tag carries the task id', await untilAsync(() => outputRow() !== undefined, 10_000) && (outputRow() ?? '').includes(`<${BASH_BACKGROUND_TASK_TAG}>${taskId}</${BASH_BACKGROUND_TASK_TAG}>`), JSON.stringify({ taskId, tail: transcriptText(sid).slice(-600) }))
  check('the row paints "moved to the background as task … — see /runs" under the output, never an exit code it does not have', exitWordsOf(null, null, taskId) === `moved to the background as task ${taskId} — see /runs` && !(outputRow() ?? '').includes('<bash-exit-code>'))
  check('the chat\'s echo row retired against the runner\'s own `!` row (one row, not two)', await untilAsync(() => connector.records().filter(r => textOf(r as never).includes(`<${BASH_INPUT_TAG}>${COMMAND}</${BASH_INPUT_TAG}>`)).length === 1, 10_000), String(connector.records().filter(r => textOf(r as never).includes(COMMAND)).length))

  section('§3 /restart names the shell as the chat\'s background work, and a runner that dies leaves it to be ended on the resume')
  const words = endingWorkWords(facts(sid)?.work ?? [])
  check('the words /restart says before the stop name the background shell with its id and command', words.includes(`background shell «${taskId}»`) && words.includes('sleep 400') && !words.includes('no watches or background shells'), words)
  const ledgerPath = join(paths.getProjectDir(work), `${sid}.task-launches.json`)
  check('the launch ledger beside the transcript holds the shell with its pid (the resume\'s road to it)', await untilAsync(() => existsSync(ledgerPath) && readFileSync(ledgerPath, 'utf8').includes(taskId), 10_000), existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').slice(0, 400) : 'no ledger')
  const sleepBefore = sleepPids()
  slot.releaseFocusedSessionConnector()
  process.kill(runnerPid, 'SIGKILL')
  check('the runner is cut (the orphaning road: a SIGKILLed runner leaves its shell behind)', await untilAsync(() => !isAlive(runnerPid), 10_000))
  const respawned = await untilAsync(() => {
    const now = recOf(sid)
    return now !== undefined && now.pid !== undefined && now.pid !== runnerPid && isAlive(now.pid)
  }, 30_000)
  check('the daemon brings the session back on a fresh runner (the crash respawn)', respawned, JSON.stringify(recOf(sid)))
  check('the resumed runner ends the orphaned shell: the sleep is gone', await untilAsync(() => sleepBefore.every(pid => !isAlive(pid)), 30_000), JSON.stringify(sleepBefore.map(pid => [pid, isAlive(pid)])))
  check('the ledger is drained once the orphan is ended (nothing left to end on the next resume)', await untilAsync(() => existsSync(ledgerPath) && !readFileSync(ledgerPath, 'utf8').includes(taskId), 15_000), existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').slice(0, 300) : 'no ledger')
  const queuedLine = (): string => JSON.stringify((facts(sid) as { queue?: Array<{ value?: string }> } | undefined)?.queue ?? [])
  check(
    'the resumed runner queues the dead-shell line for its next words: the shell is named with its command, its process "had outlived the session and was ended just now", and its kept output file',
    await untilAsync(() => queuedLine().includes(`[Background shell ${taskId} `) && queuedLine().includes('did not survive the session\'s restart after a crash') && queuedLine().includes('its process had outlived the session and was ended just now') && queuedLine().includes(`${taskId}.output`), 20_000),
    queuedLine().slice(0, 700),
  )
  check('the words are truthful about the fate: never "ended with the session" for a process that outlived it', !queuedLine().includes('its process ended with the session'), queuedLine().slice(0, 400))
  const resumedPid = recOf(sid)?.pid ?? 0
  const connectorAgain = await seat.focusDaemonSession({ sessionId: sid, runnerId: recOf(sid)?.runnerId ?? 'concourse-w1', title: 'bang', projectLabel: basename(work), workspaceId: work, home: paths.getProjectDir(work), modelKey: 'claude-sonnet-5' })
  check('the chat re-attached to the resumed runner reads idle with no shell: the key is down', await untilAsync(() => !connectorAgain.turnActive() && !shell.focusedShellRunning() && resumedPid !== 0, 10_000))
  check('the shell is gone from the roster of the resumed runner', !(facts(sid)?.work ?? []).some(r => r.kind === 'shell' && r.status === 'running'), JSON.stringify(facts(sid)?.work))
  slot.releaseFocusedSessionConnector()
} finally {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {
    void 0
  }
  await sleep(500)
  if (daemon.pid !== undefined) {
    try {
      process.kill(daemon.pid, 'SIGKILL')
    } catch {
      void 0
    }
  }
  for (const pid of sleepPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      void 0
    }
  }
  if (failures > 0) console.log(`\nforensics: ${SCRATCH}\n${readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')}`)
  else rmSync(SCRATCH, { recursive: true, force: true })
}
console.log(`\n${failures === 0 ? '✅' : '❌'} bash-line-background — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
