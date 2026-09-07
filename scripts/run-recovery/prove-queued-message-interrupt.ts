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
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const projectDir = paths.getProjectDir(work)

type Capture = { kind: string; at: number; arm?: string; route?: string; status?: number; streaming?: boolean; nth?: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)

type Row = { type?: string; uuid?: string; timestamp?: string; message?: { role?: string; content?: unknown }; attachment?: { type?: string; source_uuid?: string } }
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

const TYPED = 'two of the agents failed, recover their work in the meantime'
console.log('queued message + esc — one delivery, time order, no trailing row, on the real daemon and the chat\'s own connector')
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
  } as never)) as { ok?: boolean; sessionId?: string; error?: string }
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
  } as never)) as { ok?: boolean; sessionId?: string }
  check('the ask delivered into the opened session', run.ok === true && run.sessionId === sid, JSON.stringify(run))
  check('Q1 the seat\'s stream is held alive by the fixture (the parent waits on it)', await untilAsync(() => wire().some(c => c.kind === 'held-alive' && c.arm === ARM), 45_000), JSON.stringify(wire().map(c => c.kind)))
  check('Q1 the parent is busy in its wait', await untilAsync(() => readFacts(sid)?.busy === true, 10_000))
  await sleep(1_500)

  const receipt = await conn.sendWords(TYPED)
  const sendId = conn.recallableSend()?.clientMessageId ?? null
  check('Q2 the send was accepted under the running turn', receipt.state === 'accepted', JSON.stringify(receipt))
  check('Q2 the send has one identity (a uuid)', sendId !== null && /^[0-9a-f-]{36}$/.test(sendId), String(sendId))
  const queuedRows = (await painted()).filter(r => r.type === 'user' && textOf(r).includes(TYPED))
  check('Q2 the typed words paint at once, once, as a QUEUED row', queuedRows.length === 1 && queuedRows[0]?.queued === true, JSON.stringify(queuedRows.map(r => [r.uuid, r.queued])))
  check("Q2 the runner's queue holds the words (the facts say so)", await untilAsync(() => (readFacts(sid)?.queue ?? []).length >= 1, 10_000), JSON.stringify(readFacts(sid)?.queue))
  const pressedAt = Date.now()

  check('Q3 esc through the connector\'s own door', conn.interrupt() === true)
  const delivered = await untilAsync(async () => (await transcriptRows(sid)).some(r => r.type === 'user' && textOf(r).includes(TYPED)), 30_000, 50)
  const deliveredAt = Date.now()
  check('Q3 the queued words ran as the next turn within seconds of esc (never minutes)', delivered && deliveredAt - pressedAt < 15_000, `${delivered} after ${deliveredAt - pressedAt} ms`)
  const REPLY = /parent done|fixture answers/
  check('Q3 the reply to them landed', await untilAsync(async () => {
    const rows = await transcriptRows(sid)
    const at = rows.findIndex(r => r.type === 'user' && textOf(r).includes(TYPED))
    return at >= 0 && rows.slice(at + 1).some(r => r.type === 'assistant' && REPLY.test(textOf(r)))
  }, 30_000, 50))
  const rows = await transcriptRows(sid)
  const typedRecordAt = Date.parse(rows.find(r => r.type === 'user' && textOf(r).includes(TYPED))?.timestamp ?? '')
  check('Q3 the words ran within seconds of esc on the runner\'s own clock', Number.isFinite(typedRecordAt) && typedRecordAt - pressedAt < 10_000 && typedRecordAt >= pressedAt - 2_000, `${typedRecordAt - pressedAt} ms after the press`)
  const userRows = rows.filter(r => r.type === 'user' && textOf(r).includes(TYPED))
  const twins = rows.filter(r => r.type === 'attachment' && r.attachment?.type === 'queued_command' && r.attachment.source_uuid === sendId)
  check('Q3 exactly ONE user row carries the words — one delivery', userRows.length === 1, `${userRows.length} user rows; ${twins.length} attachment twins`)
  check("Q3 the row rides the send's own identity (the chat retires its echo by it)", userRows[0]?.uuid === sendId, `row=${userRows[0]?.uuid} send=${sendId}`)
  check('Q3 no attachment twin of the words', twins.length === 0, String(twins.length))

  const stamps = rows.map(r => Date.parse(r.timestamp ?? '')).filter(t => !Number.isNaN(t))
  const disorder = stamps.findIndex((t, i) => i > 0 && t < stamps[i - 1]! - 1_000)
  check('Q4 the transcript is in time order', disorder === -1, `row ${disorder} earlier than its predecessor`)

  await sleep(1_500)
  await painted()
  await sleep(500)
  const chat = await painted()
  console.log(`    the chat's painted rows: ${chat.map((r, i) => `${i}:${r.type}${r.queued ? '(queued)' : ''}[${String(r.uuid ?? '').slice(0, 8)}] ${textOf(r).slice(0, 40).replace(/\n/g, ' ')}`).join(' | ')}`)
  const typedRows = chat.map((r, i) => ({ r, i })).filter(({ r }) => r.type === 'user' && textOf(r).includes(TYPED))
  const replyAt = chat.findIndex((r, i) => r.type === 'assistant' && REPLY.test(textOf(r)) && i > (typedRows[0]?.i ?? -1))
  check('Q5 the chat paints the typed words once, un-queued', typedRows.length === 1 && typedRows[0]?.r.queued !== true, JSON.stringify(typedRows.map(({ r, i }) => [i, r.uuid, r.queued])))
  check('Q5 …followed by the reply: nothing of them trails under later records', replyAt > (typedRows[0]?.i ?? -1) && !chat.slice(replyAt + 1).some(r => r.type === 'user' && textOf(r).includes(TYPED)), `typed@${typedRows[0]?.i} reply@${replyAt} last=${chat.length - 1}`)
  const receipts = chat.map((r, i) => ({ r, i })).filter(({ r }) => r.type === 'system' && textOf(r).includes('still running'))
  check('Q5 the interrupt\'s own receipt painted once, at its anchor before the delivered words', receipts.length <= 1 && (receipts.length === 0 || receipts[0]!.i < (typedRows[0]?.i ?? Number.MAX_SAFE_INTEGER)), JSON.stringify(receipts.map(({ i }) => i)))
  conn.detach()
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ QUEUED MESSAGE + ESC — one delivery, time order, no trailing row' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
