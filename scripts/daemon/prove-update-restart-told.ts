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
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const NODE = (spawnSync('which', ['node'], { encoding: 'utf8' }).stdout ?? '').trim()
if (NODE === '') {
  console.error('no node on PATH')
  process.exit(1)
}
const PACK_NODE = join(REPO, 'dist', 'vendor', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
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
  console.log('\n❌ TIMEOUT — prove-update-restart-told exceeded 180s')
  process.exit(1)
}, 180_000)
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
process.env.MERCURY_DAEMON_DIR = daemonDir
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
const SHORT_X = TREE_X.slice(0, 12)
const SHORT_Y = TREE_Y.slice(0, 12)

const mkBuild = (name: string, tree: string): string => {
  const dir = join(builds, name)
  mkdirSync(join(dir, 'vendor', 'node', 'bin'), { recursive: true })
  copyFileSync(DIST, join(dir, 'mercury.mjs'))
  const manifest = JSON.parse(readFileSync(join(REPO, 'dist', 'manifest.json'), 'utf8')) as Record<string, unknown>
  manifest.buildTree = tree
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
mkBuild('X', TREE_X)
mkBuild('Y', TREE_Y)
const pointAt = (name: string, target: string): void => {
  const tmp = join(runtime, `.${name}.new`)
  rmSync(tmp, { force: true })
  symlinkSync(join('builds', target), tmp)
  renameSync(tmp, join(runtime, name))
}
pointAt('current', 'X')
pointAt('dist', 'X')

const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')
const { readSessionReceipts } = await import('../../src/services/switchboard/sessionReceipts.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')

const WATCH_NAME = 'stock watch'
const WATCH_CMD = `tail -n0 -F ${watchedLog}`
const SHELL_DESC = 'field channel watch'
const SHELL_CMD = 'sleep 300'
const ARM_PROMPT = 'arm the persistent stock watch and the background shell now'
const AFTER_PROMPT = 'report after the update restart'

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
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
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
    if (ask.includes(ARM_PROMPT)) {
      if (step === 0) {
        return answerTool(res, n, model, `toolu_mon_${n}`, 'Monitor', {
          description: WATCH_NAME,
          command: WATCH_CMD,
          persistent: true,
        })
      }
      if (step === 1) {
        return answerTool(res, n, model, `toolu_sh_${n}`, 'Bash', {
          description: SHELL_DESC,
          command: SHELL_CMD,
          run_in_background: true,
        })
      }
      return answerText(res, n, model, 'watches and background shell armed')
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
  MERCURY_DAEMON_DIR: daemonDir,
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
  buildTree?: string | null
  endedAt?: number
  stoppedAt?: number
  parkedAt?: number
  crash?: { reason?: string; respawning: boolean }
}
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(read(join(daemonDir, 'concourse-workers.json'))) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const recOf = (sid: string): Rec | undefined => records().find(w => w.sessionId === sid)
const transcriptOf = (sid: string): string => read(join(paths.getProjectDir(work), `${sid}.jsonl`))
const facts = (sid: string): { busy?: boolean; buildTree?: string | null; queue?: Array<{ value: string; mode: string }> } | undefined => {
  try {
    return JSON.parse(read(join(daemonDir, 'session-facts', `${sid}.json`))) as {
      busy?: boolean
      buildTree?: string | null
      queue?: Array<{ value: string; mode: string }>
    }
  } catch {
    return undefined
  }
}
const daemonPids = (): number[] =>
  (spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '')
    .split('\n')
    .filter(l => l.includes(' daemon run ') && l.includes(SCRATCH))
    .map(l => Number(l.trim().split(/\s+/)[0]))
    .filter(n => Number.isInteger(n) && n > 0)

const logA = join(SCRATCH, 'daemon-A.log')
const A: ChildProcess = spawn(NODE, [join(runtime, 'current', 'mercury.mjs'), 'daemon', 'run', work], {
  cwd: work,
  env: { ...daemonEnv, MERCURY_DAEMON_OWNER_PID: String(process.pid) },
  stdio: ['ignore', openSync(logA, 'a'), openSync(logA, 'a')],
})
const Apid = A.pid ?? 0

const hello = async (): Promise<{ pid: number; buildTree: string | null } | null> => {
  const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
  const reply = (await daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: '1.0.0', clientBuildTree: null } as never, {
    timeoutMs: 2000,
    protoRetry: false,
  })) as { ok?: boolean; op?: string; pid?: number; buildTree?: string | null }
  return reply.ok === true && reply.op === 'hello' && typeof reply.pid === 'number'
    ? { pid: reply.pid, buildTree: reply.buildTree ?? null }
    : null
}
const dispatch = async (
  clientMessageId: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<{ ok?: boolean; sessionId?: string; error?: string }> =>
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

const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {}
  await sleep(1000)
  for (const pid of daemonPids()) {
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
  check(
    'session armed the persistent Monitor and the background shell',
    await untilAsync(() => transcriptOf(sid).includes('watches and background shell armed') && facts(sid)?.busy === false, 60_000),
    transcriptOf(sid).slice(-400),
  )
  const allResults = recordedReqs.flatMap(r => r.results)
  const monitorTaskId = allResults.map(t => /Monitor started \(task (\S+?)[,)]/.exec(t)?.[1]).find(Boolean) ?? ''
  const shellTaskId = allResults.map(t => /Running in the background \(ID: (\S+?)\)/.exec(t)?.[1]).find(Boolean) ?? ''
  const shellOutputMatch = allResults.map(t => /Output: (\S+\.output)/.exec(t)?.[1]).find(Boolean) ?? ''
  const sessionTasksDir = shellOutputMatch ? join(shellOutputMatch, '..') : ''
  check('Monitor and background shell task ids were minted', monitorTaskId !== '' && shellTaskId !== '', `mon=${monitorTaskId} sh=${shellTaskId}`)
  const pidBefore = recOf(sid)?.pid ?? 0
  const itemsBeforeRestart = (recordedReqs[recordedReqs.length - 1]?.items.length ?? 0) + 1
  check(
    'runner reports buildTree X before the update',
    facts(sid)?.buildTree === SHORT_X && recOf(sid)?.buildTree === SHORT_X,
    JSON.stringify({ facts: facts(sid)?.buildTree, rec: recOf(sid)?.buildTree }),
  )

  section('§2 the runtime pointer moves to build Y under the daemon → the live session learns it is behind once')
  pointAt('current', 'Y')
  pointAt('dist', 'Y')
  const expectedBehindLine = `A newer Mercury build is installed (${SHORT_Y}) · this session still runs ${SHORT_X} · /restart moves it (watches and background shells end and are named)`
  const projectDir = paths.getProjectDir(work)
  const gotBehind = await untilAsync(
    () =>
      readSessionReceipts(projectDir, sid).some(r => r.summary === expectedBehindLine) &&
      transcriptOf(sid).includes(expectedBehindLine),
    15_000,
  )
  check(
    'the live session receives the "newer Mercury build is installed" line',
    gotBehind,
    JSON.stringify({ receipts: readSessionReceipts(projectDir, sid) }),
  )
  await sleep(1200)
  const behindReceiptCount = readSessionReceipts(projectDir, sid).filter(r => r.summary.includes('A newer Mercury build is installed')).length
  const behindTranscriptCount = (transcriptOf(sid).match(/A newer Mercury build is installed/g) ?? []).length
  check(
    'the "newer Mercury build is installed" line is emitted exactly once',
    behindReceiptCount === 1 && behindTranscriptCount === 1,
    `receipts=${behindReceiptCount} transcript=${behindTranscriptCount}`,
  )

  section('§3 /restart moves the session onto the new build with the update reason, naming the build and ended watches with their commands')
  const reqsBeforeRestart = recordedReqs.length
  const restarted = await dispatch('urt-restart', '/restart', { targetSessionId: sid })
  check('/restart dispatch was accepted', restarted.ok === true, JSON.stringify(restarted))
  const movedToY = await untilAsync(
    () => {
      const r = recOf(sid)
      const f = facts(sid)
      return r !== undefined && r.pid !== undefined && r.pid !== pidBefore && isProcessAlive(r.pid) && f?.buildTree === SHORT_Y
    },
    45_000,
  )
  check("/restart lands the session on the new tree (the runner's reported tree changes to Y)", movedToY, JSON.stringify({ rec: recOf(sid), factsBuildTree: facts(sid)?.buildTree }))
  check(
    "the task record files under the session's tasks dir survive the runner restart",
    sessionTasksDir !== '' &&
      existsSync(join(sessionTasksDir, `${monitorTaskId}.json`)) &&
      existsSync(join(sessionTasksDir, `${shellTaskId}.json`)),
    `dir=${sessionTasksDir}`,
  )

  const gotUpdateReceipt = await untilAsync(
    () => readSessionReceipts(projectDir, sid).some(r => r.summary.startsWith(`Mercury updated to ${SHORT_Y}`)),
    15_000,
  )
  const updateReceipt = readSessionReceipts(projectDir, sid).find(r => r.summary.startsWith(`Mercury updated to ${SHORT_Y}`))
  const updateSummary = updateReceipt?.summary ?? ''
  check(
    'the session receipt carries the update line naming the build, Monitor «name», background shell «id» (n), and re-arm',
    gotUpdateReceipt &&
      updateSummary.includes(`Mercury updated to ${SHORT_Y}`) &&
      updateSummary.includes("· this session's runner restarted · ended by the restart:") &&
      updateSummary.includes(`Monitor «${WATCH_NAME}»`) &&
      updateSummary.includes(WATCH_CMD) &&
      updateSummary.includes(`background shell «${shellTaskId}»`) &&
      updateSummary.includes(SHELL_CMD) &&
      updateSummary.includes('(2) · re-arm what you still want'),
    updateSummary,
  )

  const afterTurn = await dispatch('urt-after', AFTER_PROMPT, { targetSessionId: sid })
  check('post-restart prompt dispatched', afterTurn.ok === true, JSON.stringify(afterTurn))
  check(
    'post-restart turn settled',
    await untilAsync(() => recordedReqs.slice(reqsBeforeRestart).some(r => r.ask.includes(AFTER_PROMPT)) && facts(sid)?.busy === false, 45_000),
  )
  const newTurnItems = recordedReqs.slice(reqsBeforeRestart).flatMap(r => r.items.slice(itemsBeforeRestart))
  const newTurnContextText = JSON.stringify(newTurnItems)
  const postTranscript = transcriptOf(sid)
  check(
    "the next turn's context and chat carry the update line naming the build and ended watches",
    newTurnContextText.includes(`Mercury updated to ${SHORT_Y}`) &&
      newTurnContextText.includes("this session's runner restarted · ended by the restart:") &&
      postTranscript.includes(`Mercury updated to ${SHORT_Y}`),
    newTurnContextText.slice(-600),
  )
  check(
    'both the Monitor and the background shell armed before the restart are named afterwards with their commands in the post-restart context',
    newTurnContextText.includes(WATCH_NAME) &&
      newTurnContextText.includes(WATCH_CMD) &&
      newTurnContextText.includes(shellTaskId) &&
      newTurnContextText.includes(SHELL_CMD),
    newTurnContextText.slice(-600),
  )

  section('§4 an update never writes crash')
  const reconcileDir = mkdtempSync(join(SCRATCH, 'reconcile-update-'))
  sup.updateConcourseWorkers(workers => {
    workers['concourse-w9'] = {
      schema: 1,
      runnerId: 'concourse-w9',
      sessionId: '00000000-0000-4000-8000-000000000099',
      workspaceId: work,
      isolation: 'exclusive',
      modelKey: 'claude-sonnet-5',
      effort: 'high',
      spawnedAt: Date.now() - 10_000,
      lastLiveAt: Date.now() - 10_000,
      lastDeliveryAt: Date.now() - 5_000,
      lastTurnSettledAt: Date.now() - 4_000,
      pid: 2_147_000_000,
      buildTree: SHORT_X,
    } as never
  }, reconcileDir)
  sup.reconcileConcourseWorkers(new Set(), reconcileDir)
  const reconciledRec = sup.readSessionWorkers(reconcileDir)['concourse-w9']
  const derivedReason = reconciledRec ? sup.runnerRestartReasonOf(reconciledRec as never) : 'unknown'
  check(
    'an update never writes crash: worker record, reconcile across builds, runnerRestartReasonOf, receipts, and transcript are free of crash',
    recOf(sid)?.crash === undefined &&
      reconciledRec?.crash === undefined &&
      derivedReason === 'update' &&
      !newTurnContextText.includes('after a crash') &&
      !postTranscript.includes('after a crash') &&
      readSessionReceipts(projectDir, sid).every(r => !r.summary.includes('crash')),
    JSON.stringify({ liveCrash: recOf(sid)?.crash, reconciledCrash: reconciledRec?.crash, derivedReason }),
  )
} finally {
  await cleanup()
}

console.log(`\n${failures === 0 ? '✅ prove-update-restart-told: ALL PASS' : `❌ prove-update-restart-told: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
