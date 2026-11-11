#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_BUNDLE ?? join(ROOT, 'dist', 'mercury.mjs')
const API_KEY = 'fixture-key-000'
const SECRET = 'CANARY-MERCURY-SECRET-2207'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const page = readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8').replace(/\s+/g, ' ')
section('the page, docs/TRUST.md')
check('a hostless run denies a call that still needs approval after its rules and mode are applied', /A hostless `mercury run` denies a call that still needs approval after its rules and mode are applied/.test(page))
check("agent reads of Mercury's own stored credentials are refused", /Agent reads of Mercury's own stored credentials are refused/.test(page))

const nodeBin = Bun.which('node')
if (!existsSync(DIST) || !nodeBin) {
  check('the bundle is built (bun run build.ts; MERCURY_PROOF_BUNDLE points elsewhere) and a node binary is on PATH', false, `${DIST} · node ${nodeBin}`)
  console.log(`\nprove-monitor-hostless-run: ${checks} checks, ${failures} failed`)
  process.exit(1)
}

const world = realpathSync(mkdtempSync(join(tmpdir(), 'monitor-run-')))
const configDir = join(world, 'config')
const markers = join(world, 'markers')
const folder = join(world, 'plain')
for (const dir of [join(world, 'home'), configDir, markers, folder, join(world, 'tmp'), join(world, 'daemon')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(folder, 'README.md'), '# a plain folder\n')
writeFileSync(join(configDir, '.config.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, customApiKeyResponses: { approved: [API_KEY.slice(-20)] }, projects: { [folder]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
const secretFile = join(configDir, 'mcp-auth.json')
writeFileSync(secretFile, `${JSON.stringify({ secret: SECRET })}\n`)
const marker = (name: string): string => join(markers, name)

const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const fixture = await startFixtureApi([
  { kind: 'tool_use', name: 'Bash', input: { command: `echo fired >> ${marker('bash.write')}`, description: 'a write outside the folder' } },
  { kind: 'tool_use', name: 'Bash', input: { command: `cat ${secretFile}`, description: 'the stored credentials' } },
  { kind: 'tool_use', name: 'Monitor', input: { command: `echo fired >> ${marker('monitor.write')}`, description: 'a write outside the folder' } },
  { kind: 'tool_use', name: 'Monitor', input: { command: `cat ${secretFile} > leak.txt`, description: 'the stored credentials copied into the folder' } },
  { kind: 'paced_tool_use', preDeltas: ['a', ' moment', ' for', ' the', ' watch'], gapMs: 700, tools: [{ name: 'Read', input: { file_path: join(folder, 'leak.txt') } }] },
  { kind: 'text', text: 'done' },
])
const env: Record<string, string> = {
  HOME: join(world, 'home'),
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(nodeBin)}`,
  TERM: 'dumb',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_TMPDIR: join(world, 'tmp'),
  TMPDIR: join(world, 'tmp'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_DIR: join(world, 'daemon'),
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BROWSER_NO_DISCOVERY: '1',
  MERCURY_DESKTOP_DRIVER: 'none',
  BROWSER: '/usr/bin/true',
  GIT_CONFIG_NOSYSTEM: '1',
  ANTHROPIC_API_KEY: API_KEY,
  ANTHROPIC_BASE_URL: fixture.url,
}

section('§1 a hostless run in Default mode, a trusted plain folder, no rules')
const child = spawn(nodeBin, [DIST, 'run', 'say hi', '--model', 'claude-opus-4-8'], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stdout.on('data', () => {})
child.stderr.on('data', chunk => (stderr += chunk))
const killer = setTimeout(() => child.kill('SIGKILL'), 150_000)
const code = await new Promise<number | null>(resolve => child.on('close', value => { clearTimeout(killer); resolve(value) }))
const requests = fixture.messageRequests() as Array<{ body: unknown }>
await fixture.close()
const results: string[] = []
const seen = new Set<string>()
for (const request of requests) {
  const body = request.body as { messages?: Array<{ role: string; content: unknown }> }
  for (const message of body.messages ?? []) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue
    for (const block of message.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }>) {
      if (block.type !== 'tool_result' || seen.has(block.tool_use_id ?? '')) continue
      seen.add(block.tool_use_id ?? '')
      const content = block.content
      results.push(`${block.is_error ? 'ERROR ' : ''}${typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? '').join('\n') : JSON.stringify(content)}`)
    }
  }
}
const short = (text: string | undefined): string => (text ?? '(no result)').replaceAll('\n', ' / ').replaceAll(world, '<world>').slice(0, 230)
console.log(`  exit ${code}; ${requests.length} requests to the fixture model; tool results: ${results.map((text, index) => `[${index + 1}] ${short(text).slice(0, 150)}`).join(' ‖ ')}`)
check('the run reached the model and the five tool calls were answered', results.length >= 5, `${results.length} tool results · stderr: ${stderr.slice(-300)}`)

section('§2 controls: the same two things asked of Bash')
check('Bash · a write outside the folder is refused: nobody can approve it', !existsSync(marker('bash.write')) && /needs approval|denied|refused/i.test(results[0] ?? ''), short(results[0]))
check('Bash · a read of the stored credentials is refused', /is refused: it holds Mercury's own credentials/.test(results[1] ?? '') && !(results[1] ?? '').includes(SECRET), short(results[1]))

section('§3 the same two things asked of Monitor')
check('Monitor · a write outside the folder does not run in a hostless Default-mode run', !existsSync(marker('monitor.write')) && /needs approval|denied|refused/i.test(results[2] ?? ''), `the tool answered: ${short(results[2])}`)
const leak = join(folder, 'leak.txt')
check('Monitor · the stored credentials are not copied where the model can read them', (!existsSync(leak) || !readFileSync(leak, 'utf8').includes(SECRET)) && /is refused: it holds Mercury's own credentials/.test(results[3] ?? ''), `the tool answered: ${short(results[3])}`)
check('the model is never handed the stored credential', !requests.some(request => JSON.stringify(request.body).includes(SECRET)), `a request to the model carries the canary: Read leak.txt answered ${short(results[4])}`)

removeScratch(world)
console.log(`\nprove-monitor-hostless-run: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
