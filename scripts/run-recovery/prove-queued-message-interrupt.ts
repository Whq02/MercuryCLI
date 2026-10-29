#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs is missing — build first')
  process.exit(1)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
async function untilAsync(cond: () => boolean | Promise<boolean>, timeoutMs: number, everyMs = 50): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return true
    await sleep(everyMs)
  }
  return false
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'queued-interrupt-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# queued fixture\n')
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']]) {
  spawnSync('git', args, { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
{
  const cfgPath = join(configDir, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg.switchboardCapacity = { askedAt: 0, allowed: true, recommendedSeats: 8 }
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`)
}
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { WARM_BOOT_ALLOWANCE_MS } = await import('../../src/daemon/warmRunner.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const projectDir = paths.getProjectDir(work)

const TYPED = 'two of the agents failed, recover their work in the meantime'
const RECEIPT_WORDS = 'the operator sent a message while the crewmate held the turn'
type Capture = { kind: string; at: number; arm?: string; route?: string; status?: number; streaming?: boolean; nth?: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)

type Row = { type?: string; uuid?: string; timestamp?: string; message?: { role?: string; content?: unknown }; attachment?: { type?: string; source_uuid?: string; prompt?: unknown } }
const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')

const transcriptRows = async (sid: string): Promise<Row[]> => {
  const p = join(projectDir, `${sid}.jsonl`)
  if (!existsSync(p)) return []
  const chain = await reader.readTranscriptChainSince(p, null)
  return chain.rows as unknown as Row[]
}
const textOf = (row: Row): string => {
  const content = row.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
  return ''
}
const promptOf = (row: Row): string => {
  const prompt = row.attachment?.prompt
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) return prompt.map(b => (typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
  return ''
}
const resultTextOf = (row: Row): string => {
  const content = row.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => {
      const block = b as { type?: string; content?: unknown }
      if (block.type !== 'tool_result') return ''
      if (typeof block.content === 'string') return block.content
      if (Array.isArray(block.content)) return block.content.map(c => (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
      return ''
    })
    .join('\n')
}
const isDrainedRow = (row: Row, sendId: string | null): boolean => row.type === 'attachment' && row.attachment?.type === 'queued_command' && row.attachment.source_uuid === sendId
const carriesWords = (row: Row): boolean => (row.type === 'user' && textOf(row).includes(TYPED)) || (row.type === 'attachment' && row.attachment?.type === 'queued_command' && promptOf(row).includes(TYPED))
const readFacts = (sid: string): { busy?: boolean; queue?: unknown[] } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean; queue?: unknown[] }
  } catch {
    return undefined
  }
}

const fixture = spawn('node', [join(import.meta.dir, 'throttle-fixture-server.ts'), captureFile], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FIXTURE_READ_PATH: join(work, 'README.md') },
})
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`
const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: base,
    MERCURY_TOOL_DEFER: '0',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
    }
  }
  if (failures === 0 && process.env.QUEUED_INTERRUPT_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log('queued message + esc — one delivery, at once, time order, no trailing row, on the real daemon and the chat\'s own connector')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const ARM = 'held-alive'
  const opened = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'queued-open',
    prompt: 'throttle-open',
    workspaceDir: work,
    title: 'queued interrupt',
    model: 'claude-opus-5',
    effort: 'high',
  } as never, { timeoutMs: WARM_BOOT_ALLOWANCE_MS })) as { ok?: boolean; sessionId?: string; error?: string }
  check('the session opened', opened.ok === true && typeof opened.sessionId === 'string', JSON.stringify(opened))
  const sid = opened.sessionId ?? ''
  await untilAsync(async () => (await transcriptRows(sid)).some(r => textOf(r).includes('fixture answers')) && readFacts(sid)?.busy === false, 45_000, 50)
  const granted = (await daemonControlRpc({ op: 'sessionControl', action: 'grant-workflows', sessionId: sid, by: 'queued-drive' } as never)) as { ok?: boolean; outcome?: string }
  check('the session holds the workflows-allowed tag', granted.ok === true && (granted.outcome === undefined || granted.outcome === 'applied' || granted.outcome === 'noop'), JSON.stringify(granted))

  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const list = (await daemonControlRpc({ op: 'list', proto: 1 } as never)) as { jobs?: Array<{ sessionId: string; short: string }> }
  const entry = (list.jobs ?? []).find(j => j.sessionId === sid)
  const conn = new DaemonSessionConnector({ sessionId: sid, runnerId: entry?.short ?? 'w', title: 'queued interrupt', projectLabel: 'scratch', workspaceId: work, home: projectDir })
  await conn.attach()
  const seam = conn as unknown as { tick: () => Promise<void> }
  const painted = async (): Promise<Array<Row & { queued?: true }>> => {
    await seam.tick()
    return conn.records() as unknown as Array<Row & { queued?: true }>
  }

  const run = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'queued-run',
    prompt: `throttle-run: ${ARM}`,
    workspaceDir: work,
    title: 'queued interrupt',
    model: 'claude-opus-5',
    effort: 'high',
    targetSessionId: sid,
  } as never, { timeoutMs: WARM_BOOT_ALLOWANCE_MS })) as { ok?: boolean; sessionId?: string }
  check('the ask delivered into the opened session', run.ok === true && run.sessionId === sid, JSON.stringify(run))
  check('Q1 the seat\'s stream is held alive by the fixture (the parent waits on it)', await untilAsync(() => wire().some(c => c.kind === 'held-alive' && c.arm === ARM), 45_000), JSON.stringify(wire().map(c => c.kind)))
  check('Q1 the parent is busy in its wait', await untilAsync(() => readFacts(sid)?.busy === true, 10_000))
  check("Q1 the chat's own connector reads the turn in flight (its facts feed heard the busy edge, well inside the idle floor)", await untilAsync(() => conn.turnActive(), 5_000), JSON.stringify(conn.live()))
  await sleep(1_500)

  const sentAtMs = Date.now()
  const receipt = await conn.sendWords(TYPED)
  const sendId = conn.recallableSend()?.clientMessageId ?? null
  check('Q2 the send was accepted under the running turn', receipt.state === 'accepted', JSON.stringify(receipt))
  check('Q2 the send has one identity (a uuid)', sendId !== null && /^[0-9a-f-]{36}$/.test(sendId), String(sendId))
  const echoed = (await painted()).filter(carriesWords)
  check('Q2 the typed words paint at once, once (the chat\'s own echo, or already the drained row — never both)', echoed.length === 1, JSON.stringify(echoed.map(r => [r.type, r.uuid, r.queued])))
  const delivered = await untilAsync(async () => (await transcriptRows(sid)).some(r => isDrainedRow(r, sendId)), 15_000, 50)
  const deliveredAtMs = Date.now()
  check('Q2 the words drained into the LIVE turn within seconds of the send — no esc needed', delivered && deliveredAtMs - sentAtMs < 15_000, `${delivered} after ${deliveredAtMs - sentAtMs} ms`)
  const REPLY = /parent done|fixture answers/
  check('Q2 the reply to them landed inside the same turn', await untilAsync(async () => {
    const rows = await transcriptRows(sid)
    const at = rows.findIndex(r => isDrainedRow(r, sendId))
    return at >= 0 && rows.slice(at + 1).some(r => r.type === 'assistant' && REPLY.test(textOf(r)))
  }, 30_000, 50))
  {
    const rows = await transcriptRows(sid)
    const drained = rows.filter(r => isDrainedRow(r, sendId))
    check('Q2 exactly ONE row carries the words: the drained row under the send\'s own identity and clock', drained.length === 1 && rows.filter(carriesWords).length === 1 && Math.abs(Date.parse(drained[0]?.timestamp ?? '') - sentAtMs) <= 2_000, `${drained.length} drained · ${rows.filter(carriesWords).length} carrying · row=${drained[0]?.timestamp} sent=${new Date(sentAtMs).toISOString()}`)
    check('Q2 the Crewmate receipt the model read says the seat went to the background because the operator sent a message', rows.some(r => r.type === 'user' && resultTextOf(r).includes(RECEIPT_WORDS)), rows.filter(r => r.type === 'user' && resultTextOf(r) !== '').map(r => resultTextOf(r).slice(0, 160)).join(' | '))
  }
  check('Q2 the turn still runs: parked on the seat it handed to the background', readFacts(sid)?.busy === true && conn.turnActive(), JSON.stringify(conn.live()))
  const pressedAt = Date.now()

  check('Q3 esc through the connector\'s own door', conn.interrupt() === true)
  const ended = await untilAsync(() => readFacts(sid)?.busy === false, 15_000, 50)
  const endedAt = Date.now()
  check('Q3 the parked turn ended within seconds of esc (never minutes)', ended && endedAt - pressedAt < 15_000, `${ended} after ${endedAt - pressedAt} ms`)
  await sleep(1_500)
  const rows = await transcriptRows(sid)
  const userRows = rows.filter(r => r.type === 'user' && textOf(r).includes(TYPED))
  const drainedRows = rows.filter(r => isDrainedRow(r, sendId))
  check('Q3 the words were not delivered again: still ONE drained row, no user row twin', drainedRows.length === 1 && userRows.length === 0 && rows.filter(carriesWords).length === 1, `${userRows.length} user rows; ${drainedRows.length} drained rows`)
  check('Q3 no row of the words was written after the press', rows.filter(carriesWords).every(r => Date.parse(r.timestamp ?? '') <= pressedAt), JSON.stringify(rows.filter(carriesWords).map(r => [r.type, r.timestamp])))

  const stamps = rows.map(r => Date.parse(r.timestamp ?? '')).filter(t => !Number.isNaN(t))
  const disorder = stamps.findIndex((t, i) => i > 0 && t < stamps[i - 1]! - 1_000)
  check('Q4 the transcript is in time order', disorder === -1, `row ${disorder} earlier than its predecessor`)

  await painted()
  await sleep(500)
  const chat = await painted()
  console.log(`    the chat's painted rows: ${chat.map((r, i) => `${i}:${r.type}${r.queued ? '(queued)' : ''}[${String(r.uuid ?? '').slice(0, 8)}] ${(textOf(r) || promptOf(r)).slice(0, 40).replace(/\n/g, ' ')}`).join(' | ')}`)
  const typedRows = chat.map((r, i) => ({ r, i })).filter(({ r }) => carriesWords(r))
  const replyAt = chat.findIndex((r, i) => r.type === 'assistant' && REPLY.test(textOf(r)) && i > (typedRows[0]?.i ?? -1))
  check('Q5 the chat paints the typed words once, un-queued (the drained row took the echo\'s place)', typedRows.length === 1 && typedRows[0]?.r.queued !== true && typedRows[0]?.r.type === 'attachment', JSON.stringify(typedRows.map(({ r, i }) => [i, r.type, r.uuid, r.queued])))
  check('Q5 …followed by the reply: nothing of them trails under later records', replyAt > (typedRows[0]?.i ?? -1) && !chat.slice(replyAt + 1).some(carriesWords), `typed@${typedRows[0]?.i} reply@${replyAt} last=${chat.length - 1}`)
  const receipts = chat.map((r, i) => ({ r, i })).filter(({ r }) => r.type === 'system' && textOf(r).includes('still running'))
  check('Q5 the interrupt\'s own receipt painted at most once, after the delivered words (the press came after the delivery)', receipts.length <= 1 && (receipts.length === 0 || receipts[0]!.i > (typedRows[0]?.i ?? -1)), JSON.stringify(receipts.map(({ i }) => i)))
  conn.detach()
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ QUEUED MESSAGE + ESC — one delivery, time order, no trailing row' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
