import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const MODEL = 'claude-fable-5-1'
const HOLD_MS = 2_600

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}\n${'─'.repeat(76)}`)
}
function bump(v: string, patch: number): string {
  const parts = v.split('.')
  return `${parts[0]}.${parts[1]}.${Number(parts[2]) + patch}`
}
async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (condition()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return condition()
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — the client-contract boot proof exceeded 240 s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const oauthSource = readFileSync(join(ROOT, 'src/constants/oauth.ts'), 'utf8')
const CONTRACT = /^export const ANTHROPIC_CLIENT_CONTRACT_VERSION = '(\d+\.\d+\.\d+)'$/m.exec(oauthSource)?.[1] ?? ''
const NEWER = bump(CONTRACT, 9)

console.log('client-contract boot: a session boot peeks the registry once a day, in the background, and the next request presents what it learned')

section('§0 the boot owner — both session roads start the peek from the deferred-prefetch owner')
{
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8')
  const owner = main.slice(main.indexOf('export function startDeferredPrefetches'), main.indexOf('export function startDeferredPrefetches') + 600)
  check('the constant parses', /^\d+\.\d+\.\d+$/.test(CONTRACT), CONTRACT)
  check('the deferred-prefetch owner starts the peek (after init, bare mode excluded)', owner.includes('if (isBareMode()) return') && owner.includes('startClientContractPeek()'), owner.slice(0, 300))
  check('the interactive road runs that owner as a background node and the headless road calls it before the run', main.includes("registerBackgroundNode('deferred-prefetches', () => {\n    startDeferredPrefetches()") && /\n {4}startDeferredPrefetches\(\)\n {4}startBackgroundHousekeeping\(\)\n {2}\}\n\n {2}\/\/ 14/.test(main))
}

if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
  finish()
}
const nodeBin = Bun.which('node')
if (!nodeBin) {
  check('a node binary on PATH', false)
  finish()
}

type Read = { at: number; url: string; agent: string }
const reads: Read[] = []
let hold = false
let answeredAt = 0
let release: (() => void) | null = null
const registry = createServer((req, res) => {
  reads.push({ at: Date.now(), url: req.url ?? '', agent: String(req.headers['user-agent'] ?? '') })
  const answer = (): void => {
    release = null
    answeredAt = Date.now()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: '@anthropic-ai/claude-code', version: NEWER }))
  }
  if (!hold) {
    answer()
    return
  }
  const timer = setTimeout(answer, HOLD_MS)
  release = () => {
    clearTimeout(timer)
    answer()
  }
})
await new Promise<void>(r => registry.listen(0, '127.0.0.1', r))
const REGISTRY = `http://127.0.0.1:${(registry.address() as { port: number }).port}`

const turns: ScriptedTurn[] = Array.from({ length: 12 }, (_, i) => ({ kind: 'text' as const, text: `boot-T${i + 1}`, thinking: `boot thinking ${i + 1}`, model: MODEL }))
const fixture = await startFixtureApi(turns, { bindingCheck: true })

const scratch = mkdtempSync(join(tmpdir(), 'client-contract-boot-'))
type Arena = { home: string; config: string; cwd: string; env: Record<string, string> }
function arena(name: string, extra: Record<string, string> = {}): Arena {
  const home = join(scratch, name)
  const cwd = join(scratch, `${name}-cwd`)
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  return {
    home,
    config: join(home, '.claude'),
    cwd,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin!)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.claude'),
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_TEAMS_DIR: join(home, 'teams'),
      MERCURY_THINKING_BINDING: 'drop_block',
      MERCURY_NPM_REGISTRY_BASE: REGISTRY,
      ...extra,
    },
  }
}

type Run = { send: (prompt: string) => void; end: () => void; results: () => number; stdout: () => string; stderr: () => string; exit: Promise<number | null> }
function boot(a: Arena, sid: string): Run {
  const child = spawn(nodeBin!, [DIST, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', MODEL, '--session-id', sid], { cwd: a.cwd, env: a.env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => {
    stdout += String(d)
  })
  child.stderr.on('data', d => {
    stderr += String(d)
  })
  const killer = setTimeout(() => child.kill('SIGKILL'), 90_000)
  const exit = new Promise<number | null>(r =>
    child.on('close', code => {
      clearTimeout(killer)
      r(code)
    }),
  )
  return {
    send: prompt => child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`),
    end: () => child.stdin.end(),
    results: () => stdout.split('\n').filter(l => l.includes('"type":"result"')).length,
    stdout: () => stdout,
    stderr: () => stderr,
    exit,
  }
}

type Body = { system?: Array<{ text?: string }>; messages?: Array<{ role?: string; content?: unknown }> }
const lastUserText = (body: Body): string => JSON.stringify([...(body.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '')
const requestFor = (prompt: string): Body | undefined => fixture.messageRequests().map(r => r.body as Body).find(b => lastUserText(b).includes(prompt))
const versionOf = (body: Body | undefined): string => /cc_version=(\d+\.\d+\.\d+)\./.exec((body?.system ?? []).map(b => b.text ?? '').find(t => t.startsWith('x-anthropic-billing-header: ')) ?? '')?.[1] ?? ''
function learnedIn(a: Arena): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(a.config, 'client-contract.json'), 'utf8')) as { learned?: { version?: string } }).learned?.version
  } catch {
    return undefined
  }
}
function recordIn(a: Arena): { lastPeekAtMs?: number; lastRead?: { by?: string } } | null {
  try {
    return JSON.parse(readFileSync(join(a.config, 'client-contract.json'), 'utf8'))
  } catch {
    return null
  }
}
function notices(a: Arena, sid: string): string[] {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (entry.name === `${sid}.jsonl`) out.push(full)
    }
    return out
  }
  const root = join(a.config, 'projects')
  const found: string[] = []
  for (const file of existsSync(root) ? walk(root) : []) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('Preserved thinking')) continue
      try {
        const row = JSON.parse(line) as { payload?: { kind?: string; content?: string } }
        if (row.payload?.kind === 'notice' && typeof row.payload.content === 'string') found.push(row.payload.content)
      } catch {
        continue
      }
    }
  }
  return found
}

section('§1 the first boot of the day — one background read before any chat, the boot never waits on it, the next request presents it')
const first = arena('first')
{
  hold = true
  const run = boot(first, 'c0ffee00-0000-4000-8000-0000000c0a01')
  const peeked = await waitFor(() => reads.length >= 1, 30_000)
  check('the boot read the registry once before any chat was sent', peeked && reads.length === 1 && fixture.messageRequests().length === 0, `${reads.length} read(s), ${fixture.messageRequests().length} request(s)`)
  check('the read asked the latest document with the product agent', reads[0]?.url === '/@anthropic-ai/claude-code/latest' && (reads[0]?.agent ?? '').startsWith('mercury/') && !(reads[0]?.agent ?? '').includes(CONTRACT), JSON.stringify(reads[0] ?? null))
  run.send('boot turn one')
  const sent = await waitFor(() => requestFor('boot turn one') !== undefined, 30_000)
  const pendingWhenSent = answeredAt === 0
  check('the first turn went out while the registry read was still pending (the boot did not wait on it)', sent && pendingWhenSent, `sent=${sent} answeredAt=${answeredAt}`)
  check('the first turn presented the constant (the peek had not settled)', versionOf(requestFor('boot turn one')) === CONTRACT, versionOf(requestFor('boot turn one')))
  const releaseNow = release as (() => void) | null
  releaseNow?.()
  await waitFor(() => run.results() >= 1, 60_000)
  const settled = await waitFor(() => learnedIn(first) === NEWER && typeof recordIn(first)?.lastPeekAtMs === 'number', 15_000)
  check('the peek settled: the learned number, its day stamp and its read are in the config home', settled && recordIn(first)?.lastRead?.by === 'peek', JSON.stringify(recordIn(first)))
  run.send('boot turn two')
  await waitFor(() => run.results() >= 2, 60_000)
  run.end()
  const code = await run.exit
  check('the process ran both turns and exited 0', code === 0 && run.results() === 2, `exit=${code} results=${run.results()} ${run.stderr().slice(-400)}`)
  check('the first request after the peek settled, in the same process, presents the learned number', versionOf(requestFor('boot turn two')) === NEWER, versionOf(requestFor('boot turn two')))
  check('the whole boot made exactly one registry read', reads.length === 1, `${reads.length} read(s)`)
  const said = notices(first, 'c0ffee00-0000-4000-8000-0000000c0a01')
  check('the thinking the moved number unbound is dropped as a lawful change naming both numbers, never as a rewrite', said.some(n => n.includes(`after the client-contract number the door presents moved from ${CONTRACT} to ${NEWER}`)) && !said.some(n => n.includes("Mercury's prefix ledger names the part that moved")), JSON.stringify(said))
}

section('§2 the next boot the same day — no read; the learned number presents from its first request')
{
  hold = false
  const before = reads.length
  const run = boot(first, 'c0ffee00-0000-4000-8000-0000000c0a02')
  run.send('boot turn three')
  await waitFor(() => run.results() >= 1, 60_000)
  run.end()
  const code = await run.exit
  check('the second boot exited 0', code === 0, `exit=${code} ${run.stderr().slice(-400)}`)
  check('a second boot in the same config home the same day reads the registry nothing', reads.length === before, `${reads.length - before} read(s)`)
  check('its first request presents the learned number from the config home', versionOf(requestFor('boot turn three')) === NEWER, versionOf(requestFor('boot turn three')))
}

section('§3 the essential-traffic posture — a boot reads nothing and presents the constant')
{
  const dark = arena('dark', { MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  const before = reads.length
  const run = boot(dark, 'c0ffee00-0000-4000-8000-0000000c0a03')
  run.send('boot turn four')
  await waitFor(() => run.results() >= 1, 60_000)
  run.end()
  const code = await run.exit
  check('the dark boot exited 0', code === 0, `exit=${code} ${run.stderr().slice(-400)}`)
  check('under MERCURY_DISABLE_NONESSENTIAL_TRAFFIC the boot reads the registry nothing and writes no record', reads.length === before && recordIn(dark) === null, `${reads.length - before} read(s)`)
  check('…and presents the constant', versionOf(requestFor('boot turn four')) === CONTRACT, versionOf(requestFor('boot turn four')))
}

await fixture.close()
registry.closeAllConnections?.()
registry.close()
rmSync(scratch, { recursive: true, force: true })
finish()

function finish(): never {
  console.log('\n' + '='.repeat(76))
  if (failures > 0) {
    console.log(`❌ client-contract boot: ${failures} of ${checks} check(s) failed`)
    process.exit(1)
  }
  console.log(`✅ client-contract boot: ${checks} checks passed — one background read at boot, the boot unblocked, the next request presents it, once a day`)
  process.exit(0)
}
