#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'
import { frameLines, type Frame } from '../lib/rows.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const { ANSWER_TEXT_SCRIPT, ONE_TOOL_SETTLED_TEXT } = await import('../../src/query/scriptedStream.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

if (!existsSync(DIST)) {
  console.log('  – dist/mercury.mjs absent — build first: bun run build.ts')
  process.exit(1)
}

const CRAFT = ['filmcraft', 'lightcraft', 'photocraft'] as const
const ARM64 = 'linux-arm64'
const X64 = 'linux-x64'
const REASON = `server app: no release for ${ARM64}`

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-ext-platform-quiet-')))
const cwd = join(scratch, 'cwd')
mkdirSync(cwd, { recursive: true })

function envFor(home: string, platform: string): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_SCRIPTED_STREAM: ANSWER_TEXT_SCRIPT,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    MERCURY_CRAFT_PLATFORM: platform,
  }
  delete env.MERCURY_HOME
  delete env.NODE_ENV
  delete env.CI
  return env
}

type Row = { id: string; name: string; state: string; trust: string; health: { outcome: string; reasons: string[] } | null; path: string | null }
function listRows(home: string, platform: string): Row[] {
  const stdout = execFileSync('node', [DIST, 'extensions', 'list', '--json'], { encoding: 'utf8', cwd, env: envFor(home, platform), timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
  return (JSON.parse(stdout.slice(stdout.indexOf('{'))) as { extensions: Row[] }).extensions.filter(row => (CRAFT as readonly string[]).includes(row.name))
}

type Boot = { code: number | null; stderr: string; frames: Frame[] }
function boot(home: string, platform: string): Boot {
  const run = spawnSync('node', [DIST, 'run', '--format', 'rows', 'please do the scripted thing'], { cwd, env: envFor(home, platform), encoding: 'utf8', timeout: 120_000 })
  return { code: run.status, stderr: run.stderr ?? '', frames: frameLines(run.stdout ?? '') }
}

console.log('============================================================')
console.log(' bundled Craft extensions — no release for the platform: quiet at boot, said in the row')
console.log('============================================================')

const home = join(scratch, 'home')
seedFirstRun(home, [cwd])
const arm64Rows = listRows(home, ARM64)
check('the three Craft rows are on the roster under the arm64 pin', arm64Rows.map(r => r.name).sort().join(',') === CRAFT.join(','), arm64Rows.map(r => r.id).join(','))

console.log('[1] control: a bridge started by hand under the arm64 pin refuses with the installer\'s sentence')
for (const row of arm64Rows) {
  const bridge = join(row.path ?? '', 'server', 'bridge.mjs')
  const data = join(scratch, 'data', row.id)
  mkdirSync(data, { recursive: true })
  const run = spawnSync('node', [bridge], { encoding: 'utf8', timeout: 60_000, input: '', env: { ...envFor(home, ARM64), MERCURY_EXTENSION_DATA: data } })
  check(`${row.name}: the bridge exits non-zero and names the missing release`, run.status !== 0 && /has no supported release for linux-arm64/.test(run.stderr ?? ''), `exit ${run.status} · ${(run.stderr ?? '').trim().slice(0, 200)}`)
}

console.log('[2] a headless run under the arm64 pin: exit 0, empty stderr, no notice row, the servers not started')
{
  const run = boot(home, ARM64)
  const outcome = run.frames.find(f => f.type === 'outcome')
  const session = run.frames.find(f => f.type === 'session') as { mcp_servers?: Array<{ name: string; status: string }>; extensions?: Array<{ name: string }> } | undefined
  const notices = run.frames.filter(f => f.type === 'notice')
  check('the run exits 0 with the settled text', run.code === 0 && run.frames.some(f => f.type === 'text' && String(f.text ?? '').includes(ONE_TOOL_SETTLED_TEXT)) && outcome?.status === 'completed', `rc=${run.code} ${JSON.stringify(outcome)}`)
  check('stderr is EMPTY', run.stderr === '', JSON.stringify(run.stderr.slice(0, 300)))
  check('no notice row', notices.length === 0, JSON.stringify(notices.map(n => n.text)))
  check('the session row lists the three extensions', CRAFT.every(name => (session?.extensions ?? []).some(e => e.name === name)), JSON.stringify(session?.extensions))
  check('…and none of their servers (not started, not failed)', (session?.mcp_servers ?? []).every(s => !s.name.startsWith('ext:')), JSON.stringify(session?.mcp_servers))
}
console.log('    the same run under the x64 pin (a release exists): as quiet, the three servers connected')
{
  const run = boot(home, X64)
  const session = run.frames.find(f => f.type === 'session') as { mcp_servers?: Array<{ name: string; status: string }> } | undefined
  const servers = session?.mcp_servers ?? []
  check('x64: the run exits 0 with EMPTY stderr and no notice row', run.code === 0 && run.stderr === '' && !run.frames.some(f => f.type === 'notice'), `rc=${run.code} stderr=${JSON.stringify(run.stderr.slice(0, 300))}`)
  check('x64: the three Craft servers are connected', CRAFT.every(name => servers.some(s => s.name === `ext:${name}:app` && s.status === 'connected')), JSON.stringify(servers))
}

console.log('[3] the rows: ◑ partial with the one reason under the arm64 pin; ● on under the x64 pin')
for (const row of arm64Rows) {
  check(`${row.name}: ◑ partial with the one reason`, row.trust === 'on' && row.health?.outcome === 'partial' && JSON.stringify(row.health.reasons) === JSON.stringify([REASON]), JSON.stringify(row.health))
  check(`${row.name}: the row's words are the board's`, row.state === `◑ partial · ${REASON}`, row.state)
}
for (const row of listRows(home, X64)) {
  check(`${row.name}: ● on under the x64 pin`, row.trust === 'on' && row.health?.outcome === 'loads' && row.state === '● on', JSON.stringify({ state: row.state, health: row.health }))
}

removeScratch(scratch)
console.log(failures === 0 ? '\n ✅ BUNDLED PLATFORM QUIET — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
