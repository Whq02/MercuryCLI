#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-reissue-rows-drive.ts — every reissue paints a row,
//  on the REAL daemon and a real runner: two 529s then a reply.
//
//  The loopback is first-byte-fixture-server.ts under NODE ("overloaded
//  twice" answers 529, 529, then streams). The runner's retry budget is two
//  reissues (MERCURY_MAX_RETRIES=2 — three attempts). The laws:
//
//    R1  the reply lands after the two refusals (the third attempt)
//    R2  two retry rows are RECORDED in the transcript (one per reissue),
//        so a hosted chat paints them from the file — never a silent backoff
//    R3  the seat's wait spoke the reissue on its way ("retrying — attempt
//        n of 2 after a 529") — the concourse row reads the same
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-reissue-rows-drive.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
      /* not yet */
    }
    await sleep(everyMs)
  }
  return false
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'reissue-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# reissue fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { decodeRequestWait } = await import('../../src/services/providers/streamIdleBudget.ts')

type Capture = { kind: string; at: number; arm?: string; status?: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const readWait = (sid: string): ReturnType<typeof decodeRequestWait> => {
  try {
    const tail = JSON.parse(readFileSync(join(daemonDir, 'session-tail', `${sid}.json`), 'utf8')) as { wait?: unknown }
    return decodeRequestWait(tail.wait)
  } catch {
    return null
  }
}
const transcriptOf = (sid: string): string => {
  const p = join(paths.getProjectDir(work), `${sid}.jsonl`)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

const fixture = spawn('node', [join(import.meta.dir, 'first-byte-fixture-server.ts'), captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
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
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: base,
    MERCURY_MAX_RETRIES: '2',
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
    /* down */
  }
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log('reissue rows — every reissue paints a row on the real daemon')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const reply = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'reissue-1',
    prompt: 'overloaded twice then answer',
    workspaceDir: work,
    title: 'reissue rows',
    model: 'claude-opus-5',
    effort: 'high',
  } as never)) as { ok?: boolean; sessionId?: string }
  check('the session dispatched', reply.ok === true && typeof reply.sessionId === 'string', JSON.stringify(reply))
  const sid = reply.sessionId ?? ''
  let retryWait: ReturnType<typeof decodeRequestWait> = null
  const t0 = Date.now()
  while (Date.now() - t0 < 60_000 && !transcriptOf(sid).includes('third time lucky')) {
    const w = readWait(sid)
    if (w?.kind === 'retry' && retryWait === null) retryWait = w
    await sleep(40)
  }
  check('R1 the reply landed after the two refusals', transcriptOf(sid).includes('third time lucky'), transcriptOf(sid).slice(-400))
  check('the fixture answered 529, 529, then 200', wire().filter(x => x.kind === 'answered' && x.arm === 'overloaded').map(x => x.status).join(',') === '529,529,200', JSON.stringify(wire().filter(x => x.arm === 'overloaded')))
  const rows = transcriptOf(sid)
  const retryRows = (rows.match(/"noticeKind":"api_error"/g) ?? []).length
  check('R2 two retry rows are RECORDED in the transcript (one per reissue)', retryRows === 2, `api_error rows=${retryRows}`)
  check("R3 the seat's wait spoke the reissue ('retrying — attempt n of 2 after a 529')", retryWait?.kind === 'retry' && retryWait.reason === 'a 529' && retryWait.of === 2 && retryWait.attempt >= 1, JSON.stringify(retryWait))
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ REISSUE ROWS — every reissue paints a row; the seat spoke each one' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
