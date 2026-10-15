#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const distArg = process.argv.indexOf('--dist')
const DIST = distArg >= 0 && process.argv[distArg + 1] !== undefined ? resolve(process.argv[distArg + 1]!) : join(ROOT, 'dist', 'mercury.mjs')
const FIXTURE = join(ROOT, 'scripts', 'headless', 'mid-turn-reply-fixture-server.ts')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')
if (!existsSync(DIST)) {
  console.log('FAIL dist/mercury.mjs is missing — build first')
  process.exit(1)
}

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
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

const SCRATCH = mkdtempSync(join(tmpdir(), 'composed-reply-esc-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# composed reply fixture\n')
for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture']]) {
  spawnSync('git', args, { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
}
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const { WARM_BOOT_ALLOWANCE_MS } = await import('../../src/daemon/warmRunner.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const projectDir = paths.getProjectDir(work)

type Wire = { kind: string; n: number; arm?: string; step?: number; lines?: string[]; at: number }
const captureFile = join(SCRATCH, 'wire.jsonl')
writeFileSync(captureFile, '')
const wire = (): Wire[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        return [JSON.parse(l) as Wire]
      } catch {
        return []
      }
    })

type Row = { type?: string; uuid?: string; timestamp?: string; queued?: true; isVirtual?: true; inReplyTo?: Array<{ uuid?: string; at?: string }>; message?: { role?: string; content?: unknown }; attachment?: { type?: string; source_uuid?: string } }
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

const fixture = spawn(BUN, ['run', FIXTURE, captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
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
const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_TOOL_DEFER: '0',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
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
  if (failures === 0 && process.env.COMPOSED_REPLY_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

const LONG_ROUND_ASK = 'answer then a long tool'
const HEARD_LEAD = 'heard mid-turn: '
const LINE = 'is the second step the slow one?'
const ANSWER = `${HEARD_LEAD}${LINE}`
console.log("esc after the answer is composed — the chat's own connector keeps the reply on the screen; the transcript keeps it before the cut row")
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const opened = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'reply-open',
    prompt: 'hello there',
    workspaceDir: work,
    title: 'composed reply',
    model: 'claude-opus-5',
    effort: 'high',
    permissionMode: 'sovereign',
  } as never, { timeoutMs: WARM_BOOT_ALLOWANCE_MS })) as { ok?: boolean; sessionId?: string; error?: string }
  check('the session opened', opened.ok === true && typeof opened.sessionId === 'string', JSON.stringify(opened))
  const sid = opened.sessionId ?? ''
  check('the first turn answered', await untilAsync(async () => (await transcriptRows(sid)).some(r => r.type === 'assistant' && textOf(r).startsWith('heard: hello there')) && readFacts(sid)?.busy === false, 45_000, 50))

  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const list = (await daemonControlRpc({ op: 'list', proto: 1 } as never)) as { jobs?: Array<{ sessionId: string; short: string }> }
  const entry = (list.jobs ?? []).find(j => j.sessionId === sid)
  const conn = new DaemonSessionConnector({ sessionId: sid, runnerId: entry?.short ?? 'w', title: 'composed reply', projectLabel: 'scratch', workspaceId: work, home: projectDir })
  await conn.attach()
  const seam = conn as unknown as { tick: () => Promise<void> }
  const painted = async (): Promise<Row[]> => {
    await seam.tick()
    return conn.records() as unknown as Row[]
  }
  const paintedAnswer = (rows: Row[]): Row | undefined => rows.find(r => r.type === 'assistant' && textOf(r).startsWith(ANSWER))

  const run = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'reply-run',
    prompt: LONG_ROUND_ASK,
    workspaceDir: work,
    title: 'composed reply',
    model: 'claude-opus-5',
    effort: 'high',
    targetSessionId: sid,
  } as never, { timeoutMs: WARM_BOOT_ALLOWANCE_MS })) as { ok?: boolean; sessionId?: string }
  check('the ask delivered into the opened session', run.ok === true && run.sessionId === sid, JSON.stringify(run))
  check("round one's request went out (a 4 s tool runs)", await untilAsync(() => wire().some(w => w.kind === 'request' && w.arm === 'long' && w.step === 0), 45_000))
  check("the chat's own connector reads the turn in flight", await untilAsync(() => conn.turnActive(), 10_000), JSON.stringify(conn.live()))

  const receipt = await conn.sendWords(LINE)
  check('the line was accepted under the running turn', receipt.state === 'accepted', JSON.stringify(receipt))
  const round2 = await untilAsync(() => wire().some(w => w.kind === 'request' && w.arm === 'long' && w.step === 1), 30_000)
  const carried = wire().find(w => w.kind === 'request' && w.arm === 'long' && w.step === 1)
  check('round two carried the line to the model at the tool boundary', round2 && JSON.stringify(carried?.lines) === JSON.stringify([LINE]), JSON.stringify(carried?.lines))
  check('the composed answer paints on the chat while the 30 s tool runs', await untilAsync(async () => paintedAnswer(await painted()) !== undefined, 20_000, 100), JSON.stringify((await painted()).map(r => `${r.type}:${textOf(r).slice(0, 30)}`)))
  await sleep(300)

  const pressedAt = Date.now()
  check("esc through the connector's own door", conn.interrupt() === true)
  const samples: Array<{ ms: number; shown: boolean; source: string }> = []
  while (Date.now() - pressedAt < 6_000) {
    const rows = await painted()
    const answer = paintedAnswer(rows)
    samples.push({ ms: Date.now() - pressedAt, shown: answer !== undefined, source: answer === undefined ? '-' : answer.isVirtual === true ? 'connector' : 'disk' })
    await sleep(150)
  }
  const gaps = samples.filter(s => !s.shown)
  check('PINNED (holds on the base too): the composed answer never leaves the screen after esc — every sample in the six seconds after the press shows it', gaps.length === 0, `${gaps.length} of ${samples.length} samples without it; first gap at ${gaps[0]?.ms ?? '-'} ms; sources: ${[...new Set(samples.map(s => s.source))].join(',')}`)
  check('the interrupt ended the turn', await untilAsync(() => readFacts(sid)?.busy === false, 20_000), JSON.stringify(readFacts(sid)))
  const rows = await transcriptRows(sid)
  const idxLine = rows.findIndex(r => r.type === 'attachment' && r.attachment?.type === 'queued_command' && textOf({ message: { content: (r.attachment as { prompt?: unknown }).prompt as string } }).includes(LINE))
  const idxAnswer = rows.findIndex(r => r.type === 'assistant' && textOf(r).startsWith(ANSWER))
  const idxCut = rows.findIndex((r, i) => i > idxAnswer && r.type === 'user' && textOf(r).startsWith('[Request interrupted by user'))
  check('the transcript keeps the composed answer after the line and before the cut row', idxLine >= 0 && idxAnswer > idxLine && idxCut > idxAnswer, JSON.stringify({ idxLine, idxAnswer, idxCut, rows: rows.length }))
  const answerRecord = rows[idxAnswer]
  check("the answer's record carries its reply mark", Array.isArray(answerRecord?.inReplyTo) && answerRecord!.inReplyTo!.length === 1 && typeof answerRecord!.inReplyTo![0]!.uuid === 'string', JSON.stringify(answerRecord?.inReplyTo))
  await sleep(1_500)
  const final = await painted()
  const finalAnswer = paintedAnswer(final)
  const finalAnswerAt = final.indexOf(finalAnswer as Row)
  const finalCutAt = final.findIndex((r, i) => i > finalAnswerAt && r.type === 'user' && textOf(r).startsWith('[Request interrupted by user'))
  console.log(`    the chat's painted rows: ${final.map((r, i) => `${i}:${r.type}${r.queued ? '(queued)' : ''}${r.isVirtual ? '(live)' : ''} ${textOf(r).slice(0, 36).replace(/\n/g, ' ')}`).join(' | ')}`)
  check('once the turn settled the chat paints the answer once, from the record, before the cut row', finalAnswer !== undefined && finalAnswer.isVirtual !== true && final.filter(r => r.type === 'assistant' && textOf(r).startsWith(ANSWER)).length === 1 && finalCutAt > finalAnswerAt, JSON.stringify({ finalAnswerAt, finalCutAt, virtual: finalAnswer?.isVirtual }))
  conn.detach()
} finally {
  await cleanup()
}

console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? '\n ✅ COMPOSED REPLY SURVIVES ESC — on the screen and on the record' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
