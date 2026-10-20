#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const NODE = (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
if (NODE === '') {
  console.error('no node on PATH')
  process.exit(1)
}
const PACK_NODE = join(dirname(DIST), 'vendor', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
const STANDALONE = existsSync(PACK_NODE)
const KEEP = process.env.UPDATE_RESTART_KEEP === '1'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {}
    await sleep(everyMs)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-update-restart-told exceeded 540s')
  process.exit(1)
}, 540_000)
guard.unref?.()

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'update-restart-told-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const runtime = join(home, 'runtime')
const builds = join(runtime, 'builds')
const watchedLog = join(SCRATCH, 'stock.log')
for (const d of [home, daemonDir, work, builds]) mkdirSync(d, { recursive: true })
writeFileSync(watchedLog, '')

process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = '../daemon'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of [
  'MERCURY_HOME',
  'MERCURY_CREW_DIR',
  'MERCURY_DAEMON_OWNER_PID',
  'MERCURY_DAEMON_OWNER_FD',
  'MERCURY_DAEMON_PERSIST',
  'MERCURY_DAEMON_SUCCESSOR_OF',
  'MERCURY_DAEMON_HANDOVER_FROM',
  'NODE_ENV',
]) {
  delete process.env[k]
}

const git = (args: string[]): void => {
  const r = spawnSync('git', ['-C', work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], {
    encoding: 'utf8',
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}
git(['init', '-q'])
writeFileSync(join(work, 'README.md'), 'the update-restart-told probe repository\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'the probe commit'])
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])

const TREE_X = '111122223333'.padEnd(40, '0')
const TREE_Y = '999988887777'.padEnd(40, '0')
const TREE_Z = '555566667777'.padEnd(40, '0')
const TREE_W = '444433332222'.padEnd(40, '0')
const SHORT_X = TREE_X.slice(0, 12)
const SHORT_Y = TREE_Y.slice(0, 12)
const SHORT_Z = TREE_Z.slice(0, 12)
const SHORT_W = TREE_W.slice(0, 12)

const mkBuild = (name: string, tree: string, buildTime: string): string => {
  const dir = join(builds, name)
  mkdirSync(join(dir, 'vendor', 'node', 'bin'), { recursive: true })
  copyFileSync(DIST, join(dir, 'mercury.mjs'))
  const manifest = JSON.parse(readFileSync(join(dirname(DIST), 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.buildTree = tree
  manifest.buildTime = buildTime
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  if (STANDALONE) {
    const nodeAt = join(dir, 'vendor', 'node', 'bin', 'node')
    try {
      linkSync(PACK_NODE, nodeAt)
    } catch {
      copyFileSync(PACK_NODE, nodeAt)
    }
  }
  return dir
}
const X = mkBuild('X', TREE_X, '2026-01-01T00:00:00.000Z')
mkBuild('X2', TREE_X, '2026-01-01T00:00:00.000Z')
const Y = mkBuild('Y', TREE_Y, '2026-02-01T00:00:00.000Z')
const Z = mkBuild('Z', TREE_Z, '2026-03-01T00:00:00.000Z')
mkBuild('W', TREE_W, '2026-04-01T00:00:00.000Z')
const pointAt = (name: string, target: string): void => {
  const tmp = join(runtime, `.${name}.new`)
  rmSync(tmp, { force: true })
  symlinkSync(join('builds', target), tmp)
  renameSync(tmp, join(runtime, name))
}
const pointBoth = (target: string): void => {
  pointAt('current', target)
  pointAt('dist', target)
}
pointBoth('X')

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')
const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')
const { composeRestartLine } = await import('../../src/tools/MonitorTool/watchReceipts.ts')
const { restartSessionOnInstalledBuild } = await import('../../src/commands/restart/restart.ts')
const { moveDaemonToDeployedBuild } = await import('../../src/daemon/handshake.ts')
const { deployedRuntime, decideHandover } = await import('../../src/daemon/handover.ts')
const { decidePlaneBoot } = await import('../../src/daemon/planeBoot.ts')
const { resetOwnedDaemonBreakerForTesting } = await import('../../src/daemon/ownedDaemon.ts')
const freshProcess = (): void => resetOwnedDaemonBreakerForTesting()

const SECRET = 'probe-secret-0123456789'
const WATCH_NAME = 'stock watch'
const WATCH_CMD = `tail -n0 -F '${watchedLog}' # token=${SECRET}`
const WATCH_CMD_SHOWN = `tail -n0 -F '${watchedLog}' # token=[redacted]`
const WATCH2_NAME = 'stock watch two'
const WATCH2_CMD = `tail -n0 -F '${watchedLog}'`
const WATCH3_NAME = 'stock watch three'
const WATCH3_CMD = `tail -n0 -F '${watchedLog}' # watch-three`
const WATCH4_NAME = 'stock watch four'
const WATCH4_CMD = `tail -n0 -F '${watchedLog}' # watch-four`
const SHELL_DESC = 'field channel watch'
const SHELL_CMD = 'sleep 300'
const ARM_PROMPT = 'arm the persistent stock watch and the background shell now'
const AFTER_PROMPT = 'report after the update restart and arm the second watch'
const ARM3_PROMPT = 'arm the third watch on the installed build'
const ARM4_PROMPT = 'arm the fourth watch before the compaction'
const AFTER2_PROMPT = 'report after the daemon ended'
const SLOW_PROMPT = 'answer slowly while the install lands'
const SLOW_ANSWER_MS = 7_000
const SIBLING_PROMPT = 'the sibling chat says hello'
const BEHIND_WORDS = 'Mercury build is installed'
const FOLD_MARKER = 'Write the running record of this conversation'

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; text?: string }
type Item = { role?: string; content?: unknown }
type RecordedReq = { n: number; at: number; items: Item[]; ask: string; step: number; results: string[] }
const recordedReqs: RecordedReq[] = []

const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 }

function answerText(res: ServerResponse, n: number, model: string, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.end(
    [
      sse('message_start', {
        type: 'message_start',
        message: { id: `msg_urt_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
      }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
      sse('message_stop', { type: 'message_stop' }),
    ].join(''),
  )
}

function answerTool(res: ServerResponse, n: number, model: string, id: string, name: string, input: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  res.end(
    [
      sse('message_start', {
        type: 'message_start',
        message: { id: `msg_urt_${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
      }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }),
      sse('message_stop', { type: 'message_stop' }),
    ].join(''),
  )
}

const askOf = (content: unknown): string => {
  if (typeof content === 'string') return content.trimStart().startsWith('<system-reminder>') ? '' : content
  if (!Array.isArray(content)) return ''
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i] as Block
    if (part.type === 'text' && typeof part.text === 'string' && !part.text.trimStart().startsWith('<system-reminder>')) return part.text
  }
  return ''
}
const resultTexts = (content: unknown): string[] => {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content as Block[]) {
    if (part.type !== 'tool_result') continue
    if (typeof part.content === 'string') out.push(part.content)
    else if (Array.isArray(part.content)) out.push((part.content as Block[]).map(b => (typeof b.text === 'string' ? b.text : '')).join('\n'))
  }
  return out
}
const isToolResultItem = (item: Item): boolean =>
  item.role === 'user' && Array.isArray(item.content) && (item.content as Block[]).some(p => p.type === 'tool_result')

const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {}
    const n = recordedReqs.length + 1
    const model = typeof body.model === 'string' ? body.model : 'claude-sonnet-5'
    const items = Array.isArray(body.messages) ? (body.messages as Item[]) : []
    let askIndex = -1
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.role === 'user' && askOf(items[i]!.content) !== '') {
        askIndex = i
        break
      }
    }
    const ask = askIndex === -1 ? '' : askOf(items[askIndex]!.content)
    const step = askIndex === -1 ? 0 : items.slice(askIndex + 1).filter(isToolResultItem).length
    const results = items.filter(isToolResultItem).flatMap(it => resultTexts(it.content))
    recordedReqs.push({ n, at: Date.now(), items, ask, step, results })
    if (raw.includes(FOLD_MARKER)) {
      return answerText(res, n, model, '<analysis>the walk</analysis><summary>1. Operator Intent: the operator armed watches and kept talking. 2. Technical Ground: none. 3. Files and Code Touched: none. 4. Errors and Corrections: none. 5. Problems Worked: none. 6. Operator Messages: the words so far. 7. Open Work: none. 8. Where Work Stands: idle. 9. Next Move (optional): none. 10. Agents in flight: none.</summary>')
    }
    if (ask.includes(ARM_PROMPT)) {
      if (step === 0) return answerTool(res, n, model, `toolu_mon_${n}`, 'Monitor', { description: WATCH_NAME, command: WATCH_CMD, persistent: true })
      if (step === 1) return answerTool(res, n, model, `toolu_sh_${n}`, 'Bash', { description: SHELL_DESC, command: SHELL_CMD, run_in_background: true })
      return answerText(res, n, model, 'watches and background shell armed')
    }
    if (ask.includes(AFTER_PROMPT)) {
      if (step === 0) return answerTool(res, n, model, `toolu_mon_${n}`, 'Monitor', { description: WATCH2_NAME, command: WATCH2_CMD, persistent: true })
      return answerText(res, n, model, 'second watch armed')
    }
    if (ask.includes(ARM3_PROMPT)) {
      if (step === 0) return answerTool(res, n, model, `toolu_mon_${n}`, 'Monitor', { description: WATCH3_NAME, command: WATCH3_CMD, persistent: true })
      return answerText(res, n, model, 'third watch armed')
    }
    if (ask.includes(ARM4_PROMPT)) {
      if (step === 0) return answerTool(res, n, model, `toolu_mon_${n}`, 'Monitor', { description: WATCH4_NAME, command: WATCH4_CMD, persistent: true })
      return answerText(res, n, model, 'fourth watch armed')
    }
    if (ask.includes(SLOW_PROMPT)) {
      setTimeout(() => answerText(res, n, model, 'the slow answer landed after the install'), SLOW_ANSWER_MS)
      return
    }
    return answerText(res, n, model, `update-probe answer #${n}`)
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const daemonEnv: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: '../daemon',
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_PERMISSION_MODE: 'sovereign',
  MERCURY_OPERATOR: 'sam',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: base,
  OPENAI_API_KEY: '',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_WARM_RUNNER: '0',
}
for (const [k, v] of Object.entries(daemonEnv)) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
process.env.MERCURY_DAEMON_OWNER_PID = String(process.pid)
process.execPath = NODE
process.chdir(work)

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
type Rec = {
  runnerId: string
  sessionId: string
  pid?: number
  buildTree?: string
  restartReason?: string
  stoppedAt?: number
  crash?: { reason?: string; respawning: boolean }
}
type WorkRow = { id: string; kind: 'workflow' | 'agent' | 'shell' | 'monitor'; name: string; status: string; startTime: number; description?: string; command?: string }
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(read(join(daemonDir, 'concourse-workers.json'))) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const recOf = (sid: string): Rec | undefined => records().find(w => w.sessionId === sid)
const transcriptOf = (sid: string): string => read(join(paths.getProjectDir(work), `${sid}.jsonl`))
const facts = (sid: string): { busy?: boolean; buildTree?: string | null; work?: WorkRow[] } | undefined => {
  try {
    return JSON.parse(read(join(daemonDir, 'session-facts', `${sid}.json`))) as { busy?: boolean; buildTree?: string | null; work?: WorkRow[] }
  } catch {
    return undefined
  }
}
const ps = (pid: number): { ppid: number; command: string } => {
  const out = (spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout ?? '').trim()
  const m = /^(\d+)\s+(.*)$/.exec(out)
  return m ? { ppid: Number(m[1]), command: m[2]! } : { ppid: 0, command: '' }
}
const bundleOf = (command: string): string => {
  const script = command.split(/\s+/).find(part => part.endsWith('mercury.mjs')) ?? ''
  try {
    return realpathSync(script)
  } catch {
    return script
  }
}
const pidsInWorld = (also: (line: string) => boolean = () => true): number[] =>
  (spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter(l => l.includes(SCRATCH) && also(l))
    .map(l => Number(l.trim().split(/\s+/)[0]))
    .filter(n => Number.isInteger(n) && n > 0 && n !== process.pid)
const daemonPids = (): number[] => pidsInWorld(l => l.includes(' daemon run '))
const watchPids = (marker: string): number[] => pidsInWorld(l => l.includes('tail -n0 -F') && l.includes(marker))

const spawnDaemon = (log: string): ChildProcess =>
  spawn(NODE, [join(runtime, 'current', 'mercury.mjs'), 'daemon', 'run', work], {
    cwd: work,
    env: { ...daemonEnv, MERCURY_DAEMON_OWNER_PID: String(process.pid) },
    stdio: ['ignore', openSync(log, 'a'), openSync(log, 'a')],
  })
const logA = join(SCRATCH, 'daemon-A.log')
const A = spawnDaemon(logA)
const Apid = A.pid ?? 0

const hello = async (): Promise<{ pid: number; buildTree: string | null } | null> => {
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  const reply = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, {
    timeoutMs: 2000,
    protoRetry: false,
  })) as { ok?: boolean; op?: string; pid?: number; buildTree?: string | null }
  return reply.ok === true && reply.op === 'hello' && typeof reply.pid === 'number' ? { pid: reply.pid, buildTree: reply.buildTree ?? null } : null
}
const dispatch = async (clientMessageId: string, prompt: string, extra: Record<string, unknown> = {}): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
  (await daemonControlRpc(
    {
      op: 'concourseDispatch',
      clientMessageId,
      prompt,
      workspaceDir: work,
      title: 'Update restart probe',
      model: 'claude-sonnet-5',
      effort: 'high',
      permissionMode: 'sovereign',
      ...extra,
    } as never,
    { timeoutMs: 30_000 },
  )) as { ok?: boolean; sessionId?: string; error?: string }
const askFacts = async (sid: string): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'sessionControl', action: 'session-facts', sessionId: sid, by: 'probe' } as never, { timeoutMs: 5000 })
  } catch {}
}
const resumeAsTheScreenDoes = async (sid: string): Promise<string | null> => {
  const reply = (await daemonControlRpc(
    { op: 'sessionAdmit', workspaceDir: work, resumeSessionId: sid, isolation: 'shared', by: 'operator', restartReason: 'update' } as never,
    { timeoutMs: 60_000 },
  )) as { ok?: boolean; error?: string }
  return reply.ok === true ? null : (reply.error ?? 'the daemon refused the resume')
}
const stopSession = async (sid: string): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId: sid, by: 'operator' } as never, { timeoutMs: 15_000 })
  } catch {}
}
const turnSettled = (sid: string, words: string, ms = 45_000): Promise<boolean> => untilAsync(() => transcriptOf(sid).includes(words) && facts(sid)?.busy === false, ms)
const boundariesOnDisk = (sid: string): number =>
  transcriptOf(sid)
    .split('\n')
    .filter(line => line.includes('"kind":"boundary"') && line.includes('"boundaryKind":"compact"') && !line.includes('"updates"')).length

const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {}
  await sleep(1000)
  for (const pid of [...daemonPids(), ...pidsInWorld()]) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

try {
  section('§1 a session is born on build X and arms a persistent Monitor and a background shell')
  check('daemon A came up on build X', await untilAsync(async () => (await hello())?.pid === Apid, 45_000), read(logA).slice(-600))
  const s1 = await dispatch('urt-1', ARM_PROMPT)
  const sid = s1.sessionId ?? ''
  check('session was born on daemon A', s1.ok === true && sid !== '', JSON.stringify(s1))
  check('session armed the persistent Monitor and the background shell', await turnSettled(sid, 'watches and background shell armed', 60_000), transcriptOf(sid).slice(-400))
  const allResults = recordedReqs.flatMap(r => r.results)
  const monitorTaskId = allResults.map(t => /Monitor started \(task (\S+?)[,)]/.exec(t)?.[1]).find(Boolean) ?? ''
  const shellTaskId = allResults.map(t => /Running in the background \(ID: (\S+?)\)/.exec(t)?.[1]).find(Boolean) ?? ''
  const shellOutput = allResults.map(t => /Output: (\S+\.output)/.exec(t)?.[1]).find(Boolean) ?? ''
  check('Monitor and background shell task ids were minted', monitorTaskId !== '' && shellTaskId !== '' && shellOutput !== '', `mon=${monitorTaskId} sh=${shellTaskId} out=${shellOutput}`)
  const pidBefore = recOf(sid)?.pid ?? 0
  check(
    'the runner reports its own tree X and the record stamps X',
    facts(sid)?.buildTree === SHORT_X && recOf(sid)?.buildTree === SHORT_X && bundleOf(ps(pidBefore).command) === join(X, 'mercury.mjs'),
    JSON.stringify({ facts: facts(sid)?.buildTree, rec: recOf(sid)?.buildTree, cmd: ps(pidBefore).command }),
  )
  const projectDir = paths.getProjectDir(work)
  const behindCount = (): { receipts: number; transcript: number } => ({
    receipts: readSessionReceipts(projectDir, sid).filter(r => r.summary.includes(BEHIND_WORDS)).length,
    transcript: (transcriptOf(sid).match(new RegExp(BEHIND_WORDS, 'g')) ?? []).length,
  })
  const askFactsFor = async (ms: number): Promise<void> => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      await askFacts(sid)
      await sleep(700)
    }
  }

  section('§2 the live session is told once that it is behind, on the daemon\'s own request, and never on a false positive')
  pointBoth('X2')
  await askFactsFor(4500)
  check('a redeploy of the same build (the pointer rewritten to the same tree) tells nothing', behindCount().receipts === 0 && behindCount().transcript === 0, JSON.stringify(behindCount()))
  rmSync(join(runtime, 'current'), { force: true })
  rmSync(join(runtime, 'dist'), { force: true })
  await askFactsFor(4500)
  pointBoth('X')
  check('a pointer that briefly does not exist tells nothing', behindCount().receipts === 0 && behindCount().transcript === 0, JSON.stringify(behindCount()))
  await sleep(2500)
  pointBoth('Y')
  await askFacts(sid)
  await sleep(600)
  pointBoth('X')
  await askFactsFor(4500)
  check('a pointer that moves away and back within the confirmation window tells nothing', behindCount().receipts === 0 && behindCount().transcript === 0, JSON.stringify(behindCount()))
  const expectedBehindLine = `A newer Mercury build is installed (${SHORT_Y}). This chat still uses ${SHORT_X}. /restart switches to it; watches and background shells will stop and be listed.`
  const behindLanded = (): boolean => readSessionReceipts(projectDir, sid).some(r => r.summary === expectedBehindLine) && transcriptOf(sid).includes(expectedBehindLine)
  pointBoth('Y')
  const pointedAt = Date.now()
  const gotBehindUnasked = await untilAsync(behindLanded, 12_000, 200)
  const behindAfterMs = Date.now() - pointedAt
  check(
    'an idle session is told on the daemon\'s own request when the installed build moves — within 8 s of the install, the screen asking for nothing',
    gotBehindUnasked && behindAfterMs < 8_000,
    `${behindAfterMs} ms · ${JSON.stringify(behindCount())}`,
  )
  check('the daemon saw the install and asked its live session for its facts', read(logA).includes(`the installed build moved to ${SHORT_Y} — 1 live session(s) asked for their facts now`), read(logA).slice(-500))
  const gotBehind =
    gotBehindUnasked ||
    (await untilAsync(
      async () => {
        await askFacts(sid)
        return behindLanded()
      },
      25_000,
      700,
    ))
  check('the live session receives the "newer Mercury build is installed" line in its receipts and its chat', gotBehind, JSON.stringify({ receipts: readSessionReceipts(projectDir, sid) }))
  await askFactsFor(5000)
  check('the line is told exactly once', behindCount().receipts === 1 && behindCount().transcript === 1, JSON.stringify(behindCount()))

  section('§2b field: source builds refuse, and current runner facts win without a worker record')
  for (const [name, buildTree, words] of [
    ['source-only', null, 'this session runs a source build; /restart moves installed builds only'],
    ['current-only', SHORT_Y, 'already uses the installed Mercury build'],
  ] as const) {
    const fakeSid = 'field-' + name
    writeFileSync(join(daemonDir, 'session-facts', fakeSid + '.json'), JSON.stringify({ schema: 1, sessionId: fakeSid, model: { effective: 'fixture' }, usage: {}, queue: [], buildTree }))
    let touched = false
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await restartSessionOnInstalledBuild({ sessionId: fakeSid, turnActive: false, work: [], tell: () => { touched = true }, resume: async () => { touched = true; return null } })
      check(name + ': repeated /restart explains the running build and moves nothing', !result.ok && result.reason.includes(words) && !touched, JSON.stringify(result))
    }
  }

  section('§2c field: a clear lineage keeps installed-build notices already shown')
  const clearWork = join(SCRATCH, 'clear-work')
  mkdirSync(clearWork)
  seedFirstRun(home, [work, clearWork])
  const firstClear = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: clearWork, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'sovereign', by: 'operator', bornBlank: true } as never, { timeoutMs: 60_000 }) as { ok: boolean; sessionId?: string }
  let previousSid = firstClear.sessionId ?? ''
  const clearProject = paths.getProjectDir(clearWork)
  const clearTranscript = (id: string) => read(join(clearProject, id + '.jsonl'))
  check('an independent clear lineage was born', firstClear.ok && previousSid !== '', JSON.stringify(firstClear))
  await dispatch('clear-first-turn', 'a turn before clear', { targetSessionId: previousSid, workspaceDir: clearWork })
  check('the first lineage session receives its installed-build notice', await untilAsync(async () => { await askFacts(previousSid); return readSessionReceipts(clearProject, previousSid).some(row => row.summary.includes(BEHIND_WORDS)) }, 20_000), clearTranscript(previousSid).slice(-400))
  const clearIds: string[] = [previousSid]
  for (let count = 0; count < 2; count++) {
    const born = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: clearWork, isolation: 'shared', vacatingSessionId: previousSid, model: 'claude-sonnet-5', permissionMode: 'sovereign', by: 'operator', bornBlank: true } as never, { timeoutMs: 60_000 }) as { ok: boolean; sessionId?: string }
    const cleared = born.sessionId ?? ''
    check('clear lineage birth ' + count + ' was admitted', born.ok && cleared !== '', JSON.stringify(born))
    if (!cleared) break
    clearIds.push(cleared)
    await dispatch('clear-turn-' + count, 'a turn after clear', { targetSessionId: cleared, workspaceDir: clearWork })
    check('the cleared runner still runs X', await untilAsync(() => facts(cleared)?.buildTree === SHORT_X && facts(cleared)?.busy === false, 20_000))
    const until = Date.now() + 5_000
    while (Date.now() < until) { await askFacts(cleared); await sleep(700) }
    check('clear ' + count + ' has no repeated installed-build notice', !clearTranscript(cleared).includes(BEHIND_WORDS) && readSessionReceipts(clearProject, cleared).filter(row => row.kind === 'build-behind' && row.by === 'clear-lineage').length === 1, clearTranscript(cleared).slice(-400))
    await daemonControlRpc({ op: 'sessionControl', action: 'park', sessionId: previousSid, by: 'operator' } as never, { timeoutMs: 15_000 })
    previousSid = cleared
  }
  for (const cleared of clearIds) await stopSession(cleared)

  section('§2d field: the installed-build notice paints its words without expanding')
  const { recordToEntry } = await import('../../src/fabric/entryCodec.ts')
  const rows = transcriptOf(sid).split('\n').filter(Boolean).flatMap(line => { try { const raw = JSON.parse(line); return [recordToEntry(raw) ?? raw] } catch { return [] } })
  const notice = rows.find(row => row.type === 'system' && row.subtype === 'seat_receipt' && typeof row.content === 'string' && row.content.includes(BEHIND_WORDS))
  check('the installed-build notice is one recorded visible system row, never a hidden attachment', notice !== undefined && !rows.some(row => row.type === 'attachment' && JSON.stringify(row).includes(BEHIND_WORDS)), JSON.stringify(rows.filter(row => JSON.stringify(row).includes(BEHIND_WORDS)).map(row => row.type + (row.subtype ? ':' + row.subtype : ''))))
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const React = await import('react')
  const { SystemTextMessage } = await import('../../src/components/messages/SystemTextMessage.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
  const painted = await renderToAnsiString(React.createElement(AppStateProvider, { initialState: getDefaultAppState() }, React.createElement(SystemTextMessage, { addMargin: false, message: notice as never, verbose: false })), 100)
  const paintedFlat = painted.replace(/\s+/g, ' ')
  check('notice words and /restart paint without ctrl+o', paintedFlat.includes(BEHIND_WORDS) && paintedFlat.includes('/restart switches to it') && !paintedFlat.includes('1 line ›'), painted)

  section('§3 /restart names what ends before the stop and lands the session on the installed build through the existing doors — a second chat on the old daemon is untouched')
  const sibling = await dispatch('urt-sibling', SIBLING_PROMPT)
  const sid2 = sibling.sessionId ?? ''
  check('a second chat was born on daemon A beside the first', sibling.ok === true && sid2 !== '' && (await turnSettled(sid2, 'update-probe answer', 45_000)), JSON.stringify(sibling))
  const sid2PidBefore = recOf(sid2)?.pid ?? 0
  check('the second chat runs under daemon A on build X', sid2PidBefore !== 0 && ps(sid2PidBefore).ppid === Apid && bundleOf(ps(sid2PidBefore).command) === join(X, 'mercury.mjs'), JSON.stringify(ps(sid2PidBefore)))
  const told: Array<{ line: string; oldRunnerAlive: boolean; daemonCount: number }> = []
  const tell = (line: string): void => {
    told.push({ line, oldRunnerAlive: isProcessAlive(pidBefore), daemonCount: daemonPids().length })
  }
  const onWindows = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: false, work: [], tell, resume: resumeAsTheScreenDoes, platform: 'win32' })
  check(
    'Windows: with another chat live on this daemon, /restart refuses before stopping anything and says the control pipe cannot be taken until that chat closes',
    !onWindows.ok && onWindows.reason.includes('cannot take the control pipe while this daemon serves 2 live sessions') && onWindows.reason.includes('close the other chat on this daemon, then /restart') && told.length === 0 && recOf(sid)?.pid === pidBefore && isProcessAlive(pidBefore) && daemonPids().length === 1,
    JSON.stringify({ onWindows, pid: recOf(sid)?.pid, daemons: daemonPids() }),
  )
  check(
    'Windows: the handover decision never spawns a successor against a daemon that still serves a session; macOS and Linux hand over beside it',
    decideHandover({ daemonBuildTree: SHORT_X, deployedBuildTree: SHORT_Y, healState: 'armed', live: 1, platform: 'win32' }).handover === false &&
      decideHandover({ daemonBuildTree: SHORT_X, deployedBuildTree: SHORT_Y, healState: 'armed', live: 1, platform: 'win32' }).why.includes('control pipe') &&
      decideHandover({ daemonBuildTree: SHORT_X, deployedBuildTree: SHORT_Y, healState: 'refused', live: 0, platform: 'win32' }).handover === true &&
      decideHandover({ daemonBuildTree: SHORT_X, deployedBuildTree: SHORT_Y, healState: 'armed', live: 1, platform: 'darwin' }).handover === true &&
      decideHandover({ daemonBuildTree: SHORT_X, deployedBuildTree: SHORT_Y, healState: 'armed', live: 1, platform: 'linux' }).handover === true,
  )
  const bootFacts = { selfPid: 4242, selfBuildTree: SHORT_Y, successorOf: null, handoverFrom: 1111, lockHolder: 1111, record: { pid: 1111, buildTree: SHORT_X }, plane: { pid: 1111, buildTree: SHORT_X } }
  check(
    'Windows: a successor booting while its predecessor still answers on the pipe waits for it to leave instead of dying on the pipe; elsewhere it takes the plane',
    decidePlaneBoot(bootFacts, 'win32').road === 'wait-lock' && decidePlaneBoot(bootFacts, 'darwin').road === 'handover' && decidePlaneBoot(bootFacts, 'linux').road === 'handover' && decidePlaneBoot({ ...bootFacts, plane: null }, 'win32').road === 'handover',
    JSON.stringify({ win32: decidePlaneBoot(bootFacts, 'win32'), darwin: decidePlaneBoot(bootFacts, 'darwin'), gone: decidePlaneBoot({ ...bootFacts, plane: null }, 'win32') }),
  )
  const midTurn = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: true, work: [], tell, resume: resumeAsTheScreenDoes })
  check(
    '/restart refuses while a turn is running and touches nothing',
    !midTurn.ok && /still working.*Press esc/.test(midTurn.reason) && told.length === 0 && recOf(sid)?.pid === pidBefore && isProcessAlive(pidBefore) && daemonPids().length === 1,
    JSON.stringify({ midTurn, pid: recOf(sid)?.pid, daemons: daemonPids() }),
  )
  const workRows = facts(sid)?.work ?? []
  const reqsBeforeRestart = recordedReqs.length
  const itemsBeforeRestart = (recordedReqs[recordedReqs.length - 1]?.items.length ?? 0) + 1
  const restarted = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: facts(sid)?.busy === true, work: workRows, tell, resume: resumeAsTheScreenDoes })
  check('/restart reports the move onto the installed build', restarted.ok && restarted.line.includes(`Restarted on the installed build (${SHORT_Y})`), JSON.stringify(restarted))
  check('the work is named before any successor starts; the old session cannot hold up its own handover', told[0]?.daemonCount === 1, JSON.stringify(told))
  const pidRightAfter = recOf(sid)?.pid ?? 0
  const againAtOnce = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: false, work: [], tell: () => {}, resume: resumeAsTheScreenDoes })
  check(
    'a second /restart typed the moment the first one answers is refused as already current (no second stop, the same runner stands)',
    !againAtOnce.ok && againAtOnce.reason.includes('already uses the installed Mercury build') && recOf(sid)?.pid === pidRightAfter && isProcessAlive(pidRightAfter),
    JSON.stringify({ againAtOnce, pidRightAfter, pidNow: recOf(sid)?.pid, facts: facts(sid)?.buildTree, rec: recOf(sid)?.buildTree }),
  )
  const toldLine = told[0]?.line ?? ''
  check(
    'its words name the watch and the background shell that end, with their commands, before the stop',
    told.length === 1 &&
      told[0]!.oldRunnerAlive &&
      toldLine.includes(`Monitor «${WATCH_NAME}» (${WATCH_CMD_SHOWN})`) &&
      toldLine.includes(`background shell «${shellTaskId}» "${SHELL_DESC}" (${SHELL_CMD})`),
    JSON.stringify(told),
  )
  check('a token in a watch command never reaches the words (redacted the way exports are)', told.every(t => !t.line.includes(SECRET)) && (restarted.ok ? !restarted.line.includes(SECRET) : true), JSON.stringify(told))
  const plane = await hello()
  const Bpid = plane?.pid ?? 0
  check('a daemon of the installed build now serves the plane (the existing daemon move)', Bpid !== 0 && Bpid !== Apid && plane?.buildTree?.slice(0, 12) === SHORT_Y, JSON.stringify(plane))
  const pidAfter = recOf(sid)?.pid ?? 0
  const after = ps(pidAfter)
  check(
    "the session's new runner is a child of the installed build's daemon and runs that build's bundle (its real tree, read from the process)",
    pidAfter !== 0 && pidAfter !== pidBefore && isProcessAlive(pidAfter) && after.ppid === Bpid && bundleOf(after.command) === join(Y, 'mercury.mjs'),
    JSON.stringify({ pidBefore, pidAfter, after, Bpid }),
  )
  check(
    "the runner's own facts answer tree Y and the record stamps Y",
    await untilAsync(
      async () => {
        await askFacts(sid)
        return facts(sid)?.buildTree === SHORT_Y && recOf(sid)?.buildTree === SHORT_Y
      },
      20_000,
      500,
    ),
    JSON.stringify({ facts: facts(sid)?.buildTree, rec: recOf(sid)?.buildTree }),
  )
  check(
    'the second chat was not touched by the first chat\'s restart: the same runner, still under daemon A, still on X, idle',
    isProcessAlive(Apid) && recOf(sid2)?.pid === sid2PidBefore && isProcessAlive(sid2PidBefore) && ps(sid2PidBefore).ppid === Apid && facts(sid2)?.busy === false,
    JSON.stringify({ A: isProcessAlive(Apid), pid: recOf(sid2)?.pid, was: sid2PidBefore, ps: ps(sid2PidBefore) }),
  )
  check('two daemons serve: the old one keeps the second chat, the new one took the plane', daemonPids().length === 2 && daemonPids().includes(Apid) && daemonPids().includes(Bpid), JSON.stringify(daemonPids()))
  const siblingTurn = await dispatch('urt-sibling-2', SIBLING_PROMPT + ' again', { targetSessionId: sid2 })
  check('the second chat still answers on the old daemon after the move', siblingTurn.ok === true && (await turnSettled(sid2, 'again', 45_000)) && recOf(sid2)?.pid === sid2PidBefore, JSON.stringify({ siblingTurn, pid: recOf(sid2)?.pid }))
  await stopSession(sid2)
  check('the old daemon left once its last session left — it never hosted a runner of another build', await untilAsync(() => !isProcessAlive(Apid), 30_000), read(logA).slice(-400))
  check('exactly one daemon remains, the one on the installed build', daemonPids().length === 1 && daemonPids()[0] === Bpid, JSON.stringify(daemonPids()))
  const gotUpdateReceipt = await untilAsync(() => readSessionReceipts(projectDir, sid).some(r => r.kind === 'runner-restart' && r.summary.startsWith(`Mercury updated to ${SHORT_Y}`)), 20_000)
  const updateSummary = readSessionReceipts(projectDir, sid).find(r => r.kind === 'runner-restart')?.summary ?? ''
  check(
    'the session receipt carries the update line naming the build, the ended watch and shell with their commands, and the re-arm',
    gotUpdateReceipt &&
      updateSummary.includes("· this chat restarted · ended by the restart:") &&
      updateSummary.includes(`Monitor «${WATCH_NAME}» (${WATCH_CMD_SHOWN})`) &&
      updateSummary.includes(`background shell «${shellTaskId}» "${SHELL_DESC}" (${SHELL_CMD})`) &&
      updateSummary.includes('(2) · restart any watches or background commands you still need') &&
      !updateSummary.includes(SECRET),
    updateSummary,
  )
  const again = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: false, work: [], tell: () => {}, resume: resumeAsTheScreenDoes })
  check('a second /restart says the session already runs the installed build and moves nothing', !again.ok && again.reason.includes('already uses the installed Mercury build') && recOf(sid)?.pid === pidAfter, JSON.stringify(again))
  const afterTurn = await dispatch('urt-after', AFTER_PROMPT, { targetSessionId: sid })
  check('post-restart prompt dispatched', afterTurn.ok === true, JSON.stringify(afterTurn))
  check('post-restart turn settled (it re-armed a second watch)', await turnSettled(sid, 'second watch armed'), transcriptOf(sid).slice(-400))
  const newTurnContextText = JSON.stringify(recordedReqs.slice(reqsBeforeRestart).flatMap(r => r.items.slice(itemsBeforeRestart)))
  check(
    "the next turn's context and the chat carry the update line",
    newTurnContextText.includes(`Mercury updated to ${SHORT_Y}`) && transcriptOf(sid).includes(`Mercury updated to ${SHORT_Y}`),
    newTurnContextText.slice(-600),
  )
  check(
    'the ended shell is named with its command and its kept output file, which still stands',
    newTurnContextText.includes(`[Background shell ${shellTaskId} \\"${SHELL_DESC}\\" did not survive the session's restart after an update`) &&
      newTurnContextText.includes(`what it printed until then stays in ${shellOutput}`) &&
      existsSync(shellOutput),
    newTurnContextText.slice(-900),
  )
  const watchLineAt = newTurnContextText.indexOf(`[Monitor \\"${WATCH_NAME}\\" (task ${monitorTaskId}) did not survive the session's restart after an update`)
  check(
    'the ended watch is named with the update reason and its redacted command',
    watchLineAt !== -1 && newTurnContextText.slice(watchLineAt, watchLineAt + 600).includes('token=[redacted]') && !newTurnContextText.slice(watchLineAt, watchLineAt + 600).includes(SECRET),
    newTurnContextText.slice(-900),
  )
  check(
    'a watch and a shell stopped by the restart itself are named truthfully: their processes ended with the session (nothing was left behind to end)',
    newTurnContextText.slice(watchLineAt, watchLineAt + 600).includes('its process ended with the session') && !newTurnContextText.includes('was ended just now'),
    newTurnContextText.slice(watchLineAt, watchLineAt + 400),
  )
  await askFactsFor(3000)
  check('the runner already on the installed tree is never told it is behind', behindCount().receipts === 1, JSON.stringify(behindCount()))
  const many = Array.from({ length: 200 }, (_, i) => ({ toolUseId: `tu${i}`, taskId: `b${i}`, description: `shell ${i}`, command: 'sleep 1', outputPath: null, armedAt: i }))
  const bounded = composeRestartLine({ reason: 'update', build: SHORT_Y, watches: [], shells: many })
  check('a session with 200 ended shells gets one bounded line, not 200 names', bounded.includes(', and 194 more (200)') && bounded.length < 800, `${bounded.length} chars`)
  const longCommand = `curl -H 'Authorization: Bearer ${SECRET}' https://example.invalid && printf '%s' ${'x'.repeat(5000)}`
  const clamped = composeRestartLine({ reason: 'update', build: SHORT_Y, watches: [{ toolUseId: 'tu', taskId: 'm1', description: 'long one', command: longCommand, persistent: true, armedAt: 0 }], shells: [] })
  check('a long watch command is clamped in the line and its bearer token is never shown', clamped.length < 400 && clamped.includes('…') && !clamped.includes(SECRET), `${clamped.length} chars`)

  section('§3e `mercury update` lands while a turn is mid-flight: the daemon moves, the turn finishes on the old runner, no session is killed')
  const slowSent = await dispatch('urt-slow', SLOW_PROMPT, { targetSessionId: sid })
  check('a slow turn is in flight on the session', slowSent.ok === true && (await untilAsync(() => facts(sid)?.busy === true, 15_000)), JSON.stringify(slowSent))
  const runnerDuringUpdate = recOf(sid)?.pid ?? 0
  pointBoth('Z')
  const daemonsBeforeUpdate = daemonPids().length
  freshProcess()
  const moved = await moveDaemonToDeployedBuild({ by: 'operator:mercury update', runtime: deployedRuntime(), hosted: false })
  check(
    '`mercury update` moves the plane to a daemon of the new build while the old daemon keeps its live session',
    moved.state === 'moved' && /takes new sessions; daemon v.* keeps its 1 live session/.test(moved.line),
    JSON.stringify({ moved, daemonsBeforeUpdate }),
  )
  const Cpid = (await hello())?.pid ?? 0
  check('a daemon of build Z serves the plane and the old daemon B still stands beside it', Cpid !== 0 && Cpid !== Bpid && isProcessAlive(Bpid) && daemonPids().length === 2, JSON.stringify({ Cpid, Bpid, daemons: daemonPids() }))
  check('the mid-flight turn finishes on the same runner, under the old daemon, with its answer in the chat', await turnSettled(sid, 'the slow answer landed after the install', 60_000) && recOf(sid)?.pid === runnerDuringUpdate && ps(runnerDuringUpdate).ppid === Bpid, JSON.stringify({ runnerDuringUpdate, pid: recOf(sid)?.pid, ps: ps(runnerDuringUpdate) }))
  const zLine = `A newer Mercury build is installed (${SHORT_Z}). This chat still uses ${SHORT_Y}. /restart switches to it; watches and background shells will stop and be listed.`
  check('the session is told once, between turns, that build Z is installed', await untilAsync(() => transcriptOf(sid).includes(zLine), 15_000) && (transcriptOf(sid).match(new RegExp(zLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length === 1, transcriptOf(sid).slice(-500))
  const movedOnto = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: facts(sid)?.busy === true, work: facts(sid)?.work ?? [], tell: () => {}, resume: resumeAsTheScreenDoes })
  check('/restart after the update moves the session onto the daemon the update started', movedOnto.ok && movedOnto.line.includes(`Restarted on the installed build (${SHORT_Z})`), JSON.stringify(movedOnto))
  const pidOnC = recOf(sid)?.pid ?? 0
  check('the session now runs build Z under daemon C and the old daemon B leaves once it is empty', pidOnC !== 0 && ps(pidOnC).ppid === Cpid && bundleOf(ps(pidOnC).command) === join(Z, 'mercury.mjs') && (await untilAsync(() => !isProcessAlive(Bpid), 30_000)) && daemonPids().length === 1, JSON.stringify({ pidOnC, ps: ps(pidOnC), daemons: daemonPids() }))

  section('§4 crash stays crash; a daemon that dies mid-hand-over leaves an honest refusal and a resumable session; a Monitor that outlived its runner is ended when the session resumes')
  check(
    'a runner killed by a signal while the pointer moved keeps its crash reason',
    sup.runnerRestartReasonOf({ crash: { at: Date.now(), reason: 'crashed mid-run (exit none · signal SIGKILL)', respawning: false }, buildTree: SHORT_X } as never) === 'crash',
    String(sup.runnerRestartReasonOf({ crash: { at: Date.now(), reason: 'x', respawning: false }, buildTree: SHORT_X } as never)),
  )
  const raceDir = mkdtempSync(join(SCRATCH, 'crash-race-'))
  sup.updateConcourseWorkers(workers => {
    workers['concourse-w9'] = { schema: 1, runnerId: 'concourse-w9', sessionId: '00000000-0000-4000-8000-000000000099', workspaceId: work, isolation: 'shared', modelKey: 'claude-sonnet-5', effort: 'high', spawnedAt: 1, lastLiveAt: 1, buildTree: SHORT_X, restartReason: 'ended', crash: { at: 1, reason: 'ended with its daemon around an update', respawning: false } } as never
  }, raceDir)
  sup.markConcourseWorkerCrash('concourse-w9', { reason: 'crashed mid-run (exit none · signal SIGKILL)', respawning: true }, raceDir)
  const raced = sup.readSessionWorkers(raceDir)['concourse-w9']
  check('a crash a live daemon observes outranks a found-dead label stamped a moment before it', raced !== undefined && sup.runnerRestartReasonOf(raced) === 'crash', JSON.stringify(raced))
  const arm3 = await dispatch('urt-arm3', ARM3_PROMPT, { targetSessionId: sid })
  check('a third persistent watch is armed on build Z', arm3.ok === true && (await turnSettled(sid, 'third watch armed')), transcriptOf(sid).slice(-300))
  const watch3Pids = watchPids('watch-three')
  check('the third watch has a live process of its own', watch3Pids.length > 0, JSON.stringify(watch3Pids))
  const runnerZ = recOf(sid)?.pid ?? 0
  const CpidNow = (await hello())?.pid ?? 0
  pointBoth('W')
  const midHandover = await restartSessionOnInstalledBuild({
    sessionId: sid,
    turnActive: false,
    work: facts(sid)?.work ?? [],
    tell: () => {
      for (const pid of [CpidNow, runnerZ]) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {}
      }
    },
    resume: resumeAsTheScreenDoes,
  })
  check('the daemon of Z and its runner are gone', await untilAsync(() => !isProcessAlive(CpidNow) && !isProcessAlive(runnerZ), 15_000))
  check(
    'a /restart whose daemon dies mid-hand-over refuses in words that say the session was not stopped and stays as it is — nothing invents a success',
    !midHandover.ok && midHandover.reason.includes('the session was not stopped, so it stays as it is'),
    JSON.stringify(midHandover),
  )
  check('the orphaned watch process outlived its runner (the gap the resume closes)', watch3Pids.every(pid => isProcessAlive(pid)), JSON.stringify(watch3Pids))
  const logD = join(SCRATCH, 'daemon-D.log')
  const D = spawnDaemon(logD)
  const Dpid = D.pid ?? 0
  check('daemon D came up on build W', await untilAsync(async () => (await hello())?.pid === Dpid, 45_000), read(logD).slice(-600))
  await untilAsync(() => recOf(sid)?.crash !== undefined, 15_000)
  const deadRec = recOf(sid)
  check(
    'the record found dead with its daemon after the install reads "ended … around an update", the cause unknown, never crash or update',
    deadRec?.restartReason === 'ended' && (deadRec.crash?.reason ?? '').startsWith(`ended with its daemon around an update to ${SHORT_W} — the cause is not known`),
    JSON.stringify(deadRec),
  )
  const reqsBeforeEnded = recordedReqs.length
  const itemsBeforeEnded = (recordedReqs[recordedReqs.length - 1]?.items.length ?? 0) + 1
  const after2 = await dispatch('urt-after2', AFTER2_PROMPT, { targetSessionId: sid })
  check('a message to the session revives it on D', after2.ok === true, JSON.stringify(after2))
  check('the revived turn settled', await untilAsync(() => recordedReqs.slice(reqsBeforeEnded).some(r => r.ask.includes(AFTER2_PROMPT)) && facts(sid)?.busy === false, 45_000))
  const endedContext = JSON.stringify(recordedReqs.slice(reqsBeforeEnded).flatMap(r => r.items.slice(itemsBeforeEnded)))
  check(
    'the revived runner names the re-armed watch as ended around an update, and its chat line says the cause is not known',
    endedContext.includes(`[Monitor \\"${WATCH3_NAME}\\"`) &&
      endedContext.includes("did not survive the session's restart after it ended around an update") &&
      endedContext.includes(`This chat's process ended around an update to ${SHORT_W} — the cause is not known`) &&
      readSessionReceipts(projectDir, sid).some(r => r.kind === 'runner-restart' && r.summary.startsWith("This chat's process ended around an update")),
    endedContext.slice(-900),
  )
  check(
    'nothing after the install calls it a crash or an update',
    !endedContext.includes('after a crash') && !endedContext.includes(`Mercury updated to ${SHORT_W}`),
    endedContext.slice(-600),
  )
  check('the watch process that outlived the runner was ended when the session resumed — nothing of the dead session keeps running', watch3Pids.every(pid => !isProcessAlive(pid)) && watchPids('watch-three').length === 0, JSON.stringify({ watch3Pids, now: watchPids('watch-three') }))
  const watch3LineAt = endedContext.indexOf(`[Monitor \\"${WATCH3_NAME}\\"`)
  check(
    'the dead-watch line tells the truth about the process: it had outlived the session and was ended just now',
    watch3LineAt !== -1 && endedContext.slice(watch3LineAt, watch3LineAt + 500).includes('its process had outlived the session and was ended just now'),
    endedContext.slice(watch3LineAt, watch3LineAt + 400),
  )

  section('§4b field: a successor that cannot serve returns a bounded refusal and resumes the session')
  const sibling2 = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: clearWork, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'sovereign', by: 'operator', bornBlank: true } as never, { timeoutMs: 60_000 }) as { ok: boolean; sessionId?: string }
  check('a sibling keeps the existing daemon available during a failed handover', sibling2.ok && Boolean(sibling2.sessionId), JSON.stringify(sibling2))
  const broken = mkBuild('unavailable', 'abcdabcdabcd'.padEnd(40, '0'), '2026-05-01T00:00:00.000Z')
  writeFileSync(join(broken, 'mercury.mjs'), 'process.exit(3)\n')
  pointBoth('unavailable')
  freshProcess()
  const began = Date.now()
  let recovered = false
  const failedMove = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: false, work: [], tell: () => {}, resume: async (id, reason) => {
    recovered = reason === undefined
    const reply = await daemonControlRpc({ op: 'sessionAdmit', workspaceDir: work, resumeSessionId: id, isolation: 'shared', by: 'operator' } as never, { timeoutMs: 60_000 }) as { ok: boolean; error?: string }
    return reply.ok ? null : reply.error ?? 'resume refused'
  } })
  check('an unavailable successor returns within the handover bound and says the session resumed', !failedMove.ok && failedMove.reason.includes('within the handover wait') && failedMove.reason.includes('session resumed') && recovered && Date.now() - began < 90_000, JSON.stringify(failedMove))
  check('the restored session stays on the original available daemon', recOf(sid)?.pid !== undefined && isProcessAlive(recOf(sid)!.pid!) && ps(recOf(sid)!.pid!).ppid === Dpid)
  pointBoth('W')
  if (sibling2.sessionId) await stopSession(sibling2.sessionId)

  section('§5 a headless run never says a build is installed')
  const headlessEnv: NodeJS.ProcessEnv = { ...daemonEnv }
  delete headlessEnv.MERCURY_DAEMON_OWNER_PID
  const headless = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(NODE, [join(X, 'mercury.mjs'), 'run', 'a headless probe', '--format', 'rows'], { cwd: work, env: headlessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
  check(
    'a one-shot `mercury run` on build X with W installed answers and says nothing about builds',
    headless.status === 0 && !`${headless.stdout}${headless.stderr}`.includes(BEHIND_WORDS),
    `${headless.status} ${(headless.stdout ?? '').slice(-200)} ${(headless.stderr ?? '').slice(-300)}`,
  )

  section('§6 a watch armed before a compaction is named by the restart, and an older installed build is "another" build, not a newer one')
  const arm4 = await dispatch('urt-arm4', ARM4_PROMPT, { targetSessionId: sid })
  check('a fourth persistent watch is armed on build W', arm4.ok === true && (await turnSettled(sid, 'fourth watch armed')), transcriptOf(sid).slice(-300))
  for (const n of [1, 2, 3]) {
    const filler = await dispatch(`urt-filler-${n}`, `filler turn ${n} after the fourth watch`, { targetSessionId: sid })
    check(`filler turn ${n} settled`, filler.ok === true && (await turnSettled(sid, `filler turn ${n} after the fourth watch`)), transcriptOf(sid).slice(-300))
  }
  const foldsBefore = boundariesOnDisk(sid)
  const folded = await dispatch('urt-compact', '/compact', { targetSessionId: sid })
  check('/compact folded the conversation (a compaction boundary landed on disk) with the watch still running', folded.ok === true && (await untilAsync(() => boundariesOnDisk(sid) > foldsBefore && facts(sid)?.busy === false, 90_000)) && watchPids('watch-four').length > 0, JSON.stringify({ folded, before: foldsBefore, now: boundariesOnDisk(sid), watch: watchPids('watch-four') }))
  const behindBeforeOlder = behindCount().receipts
  pointBoth('X2')
  const olderLine = `Another Mercury build is installed (${SHORT_X}). This chat still uses ${SHORT_W}. /restart switches to it; watches and background shells will stop and be listed.`
  const olderPointedAt = Date.now()
  const gotOlder = await untilAsync(() => transcriptOf(sid).includes(olderLine), 12_000, 200)
  check('an installed build older than the running one is told as "Another Mercury build", never "newer", on the daemon\'s own request', gotOlder && Date.now() - olderPointedAt < 8_000 && behindCount().receipts === behindBeforeOlder + 1, JSON.stringify({ gotOlder, ms: Date.now() - olderPointedAt, receipts: behindCount() }))
  const reqsBeforeOlder = recordedReqs.length
  const toldOlder: string[] = []
  freshProcess()
  const ontoOlder = await restartSessionOnInstalledBuild({ sessionId: sid, turnActive: facts(sid)?.busy === true, work: facts(sid)?.work ?? [], tell: line => toldOlder.push(line), resume: resumeAsTheScreenDoes })
  check('/restart moves the session onto the older installed build and names the watch armed before the compaction as ending', ontoOlder.ok && ontoOlder.line.includes(`Restarted on the installed build (${SHORT_X})`) && toldOlder.some(line => line.includes(`Monitor «${WATCH4_NAME}»`)), JSON.stringify({ ontoOlder, toldOlder }))
  const pidOnX = recOf(sid)?.pid ?? 0
  const Epid = (await hello())?.pid ?? 0
  check('the session runs the older build (the X2 bundle, tree X) under the daemon that took the plane, and the daemon of W leaves once empty', pidOnX !== 0 && Epid !== 0 && Epid !== Dpid && ps(pidOnX).ppid === Epid && bundleOf(ps(pidOnX).command) === join(builds, 'X2', 'mercury.mjs') && (await untilAsync(() => !isProcessAlive(Dpid), 30_000)), JSON.stringify({ pidOnX, Epid, Dpid, ps: ps(pidOnX) }))
  const updateToX = await untilAsync(() => readSessionReceipts(projectDir, sid).some(r => r.kind === 'runner-restart' && r.summary.startsWith(`Mercury updated to ${SHORT_X}`) && r.summary.includes(`Monitor «${WATCH4_NAME}»`)), 20_000)
  check('the update receipt names the watch that was armed before the compaction (the transcript no longer carries its launch)', updateToX, JSON.stringify(readSessionReceipts(projectDir, sid).filter(r => r.kind === 'runner-restart').map(r => r.summary)))
  const afterOlder = await dispatch('urt-after-older', 'report after the move onto the older build', { targetSessionId: sid })
  check('a turn after the move settled', afterOlder.ok === true && (await turnSettled(sid, 'report after the move onto the older build')), transcriptOf(sid).slice(-300))
  const olderContext = JSON.stringify(recordedReqs.slice(reqsBeforeOlder).flatMap(r => r.items))
  check(
    'the next turn names the pre-compaction watch as dead with its command, and its process ended with the session',
    olderContext.includes(`[Monitor \\"${WATCH4_NAME}\\"`) && olderContext.includes('watch-four') && olderContext.includes("did not survive the session's restart after an update") && watchPids('watch-four').length === 0,
    olderContext.slice(-900),
  )
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅ prove-update-restart-told: ALL PASS' : `❌ prove-update-restart-told: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
