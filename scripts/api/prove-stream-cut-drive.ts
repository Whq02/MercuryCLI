#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = import.meta.dir
const REPO = resolve(HERE, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const KEEP = process.argv.includes('--keep')
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const PROBE_KEY = 'proof-key-ci-gate-not-a-real-key'
const FIXTURE = join(HERE, 'streamCutFixture.mjs')
const j = (v: unknown): string => JSON.stringify(v)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the stream-cut drive exceeded 300s')
  process.exit(1)
}, 300_000)
guard.unref?.()

if (!existsSync(DIST)) {
  console.log(`❌ no bundle at ${DIST}`)
  process.exit(1)
}
const SCRATCH = join(realpathSync(process.env.MERCURY_CONFIG_DIR ?? tmpdir()), `stream-cut-drive-${randomUUID().slice(0, 8)}`)
mkdirSync(SCRATCH, { recursive: true })
if (!KEEP) process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }))

const minted = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(SCRATCH, 'key.pem'), '-out', join(SCRATCH, 'cert.pem'), '-days', '3650', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' })
const TLS = minted.status === 0 && existsSync(join(SCRATCH, 'cert.pem'))
console.log(`bundle: ${DIST}\nnode: ${NODE}\nwire: ${TLS ? 'TLS with ALPN h2 and http/1.1 offered (the client picks)' : `plain HTTP/1.1 (openssl minted no certificate: ${(minted.error?.message ?? minted.stderr ?? '').trim().slice(0, 120)})`}`)

type Seen = { stream: boolean; step: string; protocol: string; connection: number }
type Fixture = { port: number; dir: string; seen: () => Seen[]; kill: () => void }
async function startFixture(name: string, plan: string): Promise<Fixture> {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  if (TLS) {
    writeFileSync(join(dir, 'key.pem'), readFileSync(join(SCRATCH, 'key.pem')))
    writeFileSync(join(dir, 'cert.pem'), readFileSync(join(SCRATCH, 'cert.pem')))
  }
  writeFileSync(join(dir, 'seen.jsonl'), '')
  const child = spawn(NODE, [FIXTURE, '--dir', dir, '--plan', plan, ...(TLS ? ['--tls'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolvePort, reject) => {
    const killer = setTimeout(() => reject(new Error('fixture never printed its port')), 20_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      const m = /PORT (\d+)/.exec(chunk.toString('utf8'))
      if (m) {
        clearTimeout(killer)
        resolvePort(Number(m[1]))
      }
    })
    child.on('exit', code => reject(new Error(`fixture exited early (${code})`)))
  })
  return {
    port,
    dir,
    seen: () =>
      readFileSync(join(dir, 'seen.jsonl'), 'utf8')
        .split('\n')
        .filter(l => l.trim() !== '')
        .map(l => JSON.parse(l) as Seen),
    kill: () => {
      try {
        child.kill('SIGTERM')
      } catch {}
    },
  }
}

type Run = { status: number | null; stdout: string; stderr: string; rows: Array<Record<string, unknown>>; debug: string }
function runProduct(fixture: Fixture, prompt: string): Run {
  const home = join(fixture.dir, 'home')
  const cwd = join(fixture.dir, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(home, '.mercury.json'),
    j({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      customApiKeyResponses: { approved: [PROBE_KEY.slice(-20)], rejected: [] },
    }),
  )
  writeFileSync(join(home, 'settings.json'), '{}')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    ANTHROPIC_API_KEY: PROBE_KEY,
    ANTHROPIC_BASE_URL: `${TLS ? 'https' : 'http'}://127.0.0.1:${fixture.port}`,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_MAX_RETRIES: '2',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_TERMINAL_TITLE: '0',
    BROWSER: '/usr/bin/true',
    ...(TLS ? { NODE_EXTRA_CA_CERTS: join(SCRATCH, 'cert.pem') } : {}),
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.MERCURY_MODEL
  delete env.MERCURY_DISABLE_NONSTREAMING_FALLBACK
  const debugFile = join(fixture.dir, 'debug.txt')
  const result = spawnSync(NODE, [DIST, 'run', prompt, '--model', 'claude-sonnet-5', '--mode', 'sovereign', '--format', 'text', '--log-file', debugFile], { cwd, env, encoding: 'utf8', timeout: 120_000 })
  const rows: Array<Record<string, unknown>> = []
  const projects = join(home, 'projects')
  if (existsSync(projects)) {
    for (const slug of readdirSync(projects)) {
      const slugDir = join(projects, slug)
      for (const file of readdirSync(slugDir)) {
        if (!file.endsWith('.jsonl')) continue
        for (const line of readFileSync(join(slugDir, file), 'utf8').split('\n')) {
          if (line.trim() === '') continue
          try {
            rows.push(JSON.parse(line) as Record<string, unknown>)
          } catch {}
        }
      }
    }
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', rows, debug: existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '' }
}
const noticeRows = (run: Run, kind: string): Array<Record<string, unknown>> =>
  run.rows.map(r => r.payload as Record<string, unknown> | undefined).filter((p): p is Record<string, unknown> => p !== undefined && p.kind === 'notice' && p.noticeKind === kind)
const seenWords = (seen: Seen[]): string => seen.map(s => `${s.step}${s.stream ? '' : '(collected)'}@${s.protocol}#${s.connection}`).join(',')
const CUT_CODES = new Set(['ERR_HTTP2_STREAM_ERROR', 'UND_ERR_SOCKET'])

section('D1 · the reply is cut mid-stream, the reissue is cut, the collected fallback is cut: the turn still answers')
{
  const fixture = await startFixture('triple-cut', 'rst,rst,rst,full')
  const run = runProduct(fixture, 'say hi')
  fixture.kill()
  const seen = fixture.seen()
  console.log(`  wire seen by the fixture: ${seenWords(seen)}`)
  check('the run exits 0 with the collected reply, never "Execution error: API Error: terminated"', run.status === 0 && run.stdout.includes('recovered without streaming') && !run.stderr.includes('API Error: terminated'), `rc=${run.status} stdout=${run.stdout.trim().slice(0, 120)} stderr=${run.stderr.trim().slice(0, 200)}`)
  check('four requests reached the fixture: the stream, its reissue, the collected fallback, the fallback retried', seen.map(s => `${s.step}${s.stream ? '' : '(collected)'}`).join(',') === 'rst,rst,rst(collected),full(collected)', seenWords(seen))
  check('the reissue rode a different connection than the cut one', seen.length >= 2 && seen[0]!.connection !== seen[1]!.connection, seenWords(seen))
  const cuts = noticeRows(run, 'stream_cut')
  const fields = (cuts[0]?.fields ?? {}) as { road?: string; code?: string }
  check('the record carries the stream-cut notice naming Anthropic and the transport code', cuts.length === 1 && fields.road === 'Anthropic' && typeof fields.code === 'string' && CUT_CODES.has(fields.code), j(cuts.map(c => c.fields)))
  check('the debug log names the cut and the fresh connection', /cut the connection mid-response — .* — reissuing the stream on a fresh connection/.test(run.debug), run.debug.split('\n').filter(l => /ERROR|WARN/.test(l)).join(' | ').slice(0, 600))
}

section('D2 · one cut mid-stream: the reply streams again on a fresh connection, no blocking fallback')
{
  const fixture = await startFixture('single-cut', 'rst,full')
  const run = runProduct(fixture, 'say hi')
  fixture.kill()
  const seen = fixture.seen()
  console.log(`  wire seen by the fixture: ${seenWords(seen)}`)
  check('the run exits 0 with the STREAMED reply', run.status === 0 && run.stdout.includes('the whole reply'), `rc=${run.status} stdout=${run.stdout.trim().slice(0, 120)} stderr=${run.stderr.trim().slice(0, 200)}`)
  check('two streaming requests, no collected request', seen.map(s => `${s.step}${s.stream ? '' : '(collected)'}`).join(',') === 'rst,full', seenWords(seen))
  check('the reissue rode a fresh connection', seen.length === 2 && seen[0]!.connection !== seen[1]!.connection, seenWords(seen))
  check('no api_error row on the record: the cut was a notice, not an error', noticeRows(run, 'api_error').length === 0 && noticeRows(run, 'stream_cut').length === 1, j(run.rows.map(r => (r.payload as { noticeKind?: string }).noticeKind).filter(Boolean)))
}

console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
