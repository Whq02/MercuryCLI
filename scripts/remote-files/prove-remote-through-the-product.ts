#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { localTransportUnavailable, remoteWorld, sshdUnavailable, underScratchHome, type RemoteWorld } from './remoteKit.ts'

const HOME = underScratchHome(import.meta.path)
const DIST = process.env.REMOTE_KIT_DIST ?? join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
const PORT = 27069
const MODEL = 'claude-opus-4-8'
const KEY = 'fixture-key-000'
const launch = realpathSync(mkdtempSync(join(tmpdir(), 'remote-product-')))

const watchdog = setTimeout(() => {
  console.log('  [FAIL] the proof did not finish within 420 seconds')
  process.exit(1)
}, 420_000)
watchdog.unref()
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Turn = { kind: 'tool_use'; name: string; input: Record<string, unknown> } | { kind: 'text'; text: string }
type Request = { body: { messages?: Array<{ role: string; content: unknown }> }; raw?: string }
type Ran = { code: number | null; answers: string[]; prompts: string[]; sent: string[]; raw: string; stderr: string }

const vendoredNode = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(vendoredNode) ? vendoredNode : (Bun.which('node') ?? 'node')
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => (block !== null && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '')).join('')
      : ''

async function run(name: string, world: RemoteWorld, prompt: string, turns: Turn[], settings: Record<string, unknown>, flags: string[]): Promise<Ran & { project: string; tmp: string }> {
  const root = join(launch, name)
  const cfg = join(root, 'home', '.mercury')
  const project = join(root, 'project')
  const tmp = join(cfg, 'tmp')
  for (const dir of [tmp, project]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(project, 'README.md'), '# a project\n\nOne line of text.\n')
  process.env.ANTHROPIC_API_KEY = KEY
  seedFirstRun(cfg, [project])
  writeFileSync(join(cfg, 'settings.json'), JSON.stringify(settings))
  const fixture = await startFixtureApi(turns as never)
  const child = spawn(NODE, [DIST, ...flags, 'run', '--model', MODEL, '--format', 'json', prompt], {
    cwd: project,
    env: {
      PATH: `${world.env.PATH}:${dirname(NODE)}`,
      HOME: world.env.HOME!,
      USERPROFILE: world.env.HOME!,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: cfg,
      MERCURY_TMPDIR: tmp,
      MERCURY_DAEMON_DIR: join(root, 'home', 'daemon'),
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_CREDENTIAL_STORE: 'file',
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_BASE_URL: fixture.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stdout.on('data', () => {})
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000)
    child.on('close', status => {
      clearTimeout(timer)
      resolve(status)
    })
  })
  const requests = fixture.messageRequests() as Request[]
  await fixture.close()
  const answers: string[] = []
  const prompts: string[] = []
  for (const request of requests) {
    const last = request.body.messages?.at(-1)
    const blocks = Array.isArray(last?.content) ? (last!.content as Array<{ type?: string; content?: unknown; text?: unknown }>) : []
    const result = blocks.find(block => block.type === 'tool_result')
    if (result !== undefined) answers.push(textOf(result.content))
    else prompts.push(textOf(last?.content))
  }
  const sent = requests.map(request => request.raw ?? JSON.stringify(request.body))
  return { code, answers, prompts, sent, raw: sent.join('\n'), stderr, project, tmp }
}

const row = (index: number): string => `${String(index).padStart(7, '0')} ${'entry '.repeat(12)}`

async function through(world: RemoteWorld): Promise<void> {
  const name = world.transport
  const data = world.data
  const proj = join(data, 'proj')
  const secret = join(data, 'secret')
  for (const dir of [join(proj, 'src'), join(data, 'tree', 'sub'), secret]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(data, 'big.log'), Array.from({ length: 300_000 }, (_, index) => row(index + 1)).join('\n') + '\n')
  for (const file of ['b.txt', 'a.txt', '.hidden']) writeFileSync(join(data, 'tree', file), '')
  writeFileSync(join(proj, 'src', 'a.ts'), 'export const port = 8080\nserver.listen(port)\n')
  writeFileSync(join(proj, 'src', 'b.ts'), 'console.log("b")\n')
  writeFileSync(join(proj, 'config.yml'), 'name: app\nport: 80\n')
  writeFileSync(join(secret, 'key.txt'), 'THE-KEY\n')
  const at = (path: string): string => `ssh://box${path}`
  const turns: Turn[] = [
    { kind: 'tool_use', name: 'Read', input: { file_path: at(join(data, 'big.log')), offset: 250_000, limit: 3 } },
    { kind: 'tool_use', name: 'Read', input: { file_path: at(join(data, 'big.log')), offset: 250_003, limit: 2 } },
    { kind: 'tool_use', name: 'Read', input: { file_path: at(join(data, 'tree')) } },
    { kind: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts', path: at(proj) } },
    { kind: 'tool_use', name: 'Grep', input: { pattern: 'listen', path: at(proj), output_mode: 'content' } },
    { kind: 'tool_use', name: 'Read', input: { file_path: at(join(proj, 'config.yml')) } },
    { kind: 'tool_use', name: 'Edit', input: { file_path: at(join(proj, 'config.yml')), old_string: 'port: 80', new_string: 'port: 8080' } },
    { kind: 'tool_use', name: 'Bash', input: { command: `printf 'someone: else\\n' >> '${join(proj, 'config.yml')}'`, description: 'another writer' } },
    { kind: 'tool_use', name: 'Edit', input: { file_path: at(join(proj, 'config.yml')), old_string: 'name: app', new_string: 'name: mine' } },
    { kind: 'tool_use', name: 'Write', input: { file_path: at(join(proj, 'made', 'notes.md')), content: '# notes\n' } },
    { kind: 'tool_use', name: 'Read', input: { file_path: at(join(secret, 'key.txt')) } },
    { kind: 'text', text: 'Done.' },
  ]
  const prompt = `Look at ${at(proj)} and do the work.`
  const ran = await run(`${name}-remote`, world, prompt, turns, { guardrails: { deny: [`Read(ssh://box${secret}/**)`] } }, ['--sovereign'])
  const [page, next, folder, globbed, grepped, read, edited, , stale, written, denied] = ran.answers
  section(`${name} · one run of the built product against the remote machine, eleven tool calls`)
  check(`${name}: the run ends well and every call was answered`, ran.code === 0 && ran.answers.length === 11, `exit ${ran.code}, ${ran.answers.length} answers; ${ran.stderr.slice(-300)}`)
  check(`${name}: Read: three lines from line 250,000 of a 23 MB file`, (page ?? '').includes(`250000\t${row(250_000)}`) && (page ?? '').includes(`250002\t${row(250_002)}`) && !(page ?? '').includes(row(250_003)), (page ?? '').slice(0, 300))
  check(`${name}: Read: the page after it`, (next ?? '').includes(`250003\t${row(250_003)}`) && (next ?? '').includes(`250004\t${row(250_004)}`), (next ?? '').slice(0, 300))
  check(`${name}: Read: a folder is listed`, ['a.txt', 'b.txt', '.hidden', 'sub/'].every(entry => (folder ?? '').includes(entry)), (folder ?? '').slice(0, 300))
  check(`${name}: Glob: the files that match, as paths on that machine`, (globbed ?? '').split('\n').sort().join('|') === [at(join(proj, 'src', 'a.ts')), at(join(proj, 'src', 'b.ts'))].join('|'), globbed ?? '')
  check(`${name}: Grep: the line that matches, and what was read to find it`, (grepped ?? '').startsWith(`${at(join(proj, 'src', 'a.ts'))}:2:server.listen(port)`) && /\n\(read 3 files, \d+ bytes, from box: it has no ripgrep; with rg installed there the search runs on the host\)$/.test(grepped ?? ''), grepped ?? '')
  check(`${name}: Edit: the file as it was read is changed`, (edited ?? '').startsWith(`The file ${at(join(proj, 'config.yml'))} has been updated`) && (read ?? '').includes('port: 80'), `${(read ?? '').slice(0, 120)} | ${(edited ?? '').slice(0, 200)}`)
  check(`${name}: Edit: after another writer changed the file, the edit is refused and their line stands`, /changed|modified/i.test(stale ?? '') && !(stale ?? '').includes('has been updated') && readFileSync(join(proj, 'config.yml'), 'utf8') === 'name: app\nport: 8080\nsomeone: else\n', `${(stale ?? '').slice(0, 300)} | ${JSON.stringify(readFileSync(join(proj, 'config.yml'), 'utf8'))}`)
  check(`${name}: Write: a new file, in a folder that did not exist`, (written ?? '').startsWith(`File created successfully at: ${at(join(proj, 'made', 'notes.md'))}`) && existsSync(join(proj, 'made', 'notes.md')) && readFileSync(join(proj, 'made', 'notes.md'), 'utf8') === '# notes\n', (written ?? '').slice(0, 300))
  check(`${name}: a deny rule on a remote path holds, in the mode that asks nothing`, (denied ?? '').includes(`is denied by the rule Read(ssh://box${secret}/**)`) && !(denied ?? '').includes('THE-KEY'), (denied ?? '').slice(0, 300))
  check(`${name}: nothing was written on this disk under the spelling the paths collapse to`, !existsSync(join(ran.project, 'ssh:')) && readdirSync(ran.project).join() === 'README.md', readdirSync(ran.project).join(' '))
  const connections = world.connectLines().filter(line => / -- box sh$/.test(line)).length
  check(`${name}: the whole run used one connection, and left nothing in Mercury's private folder`, connections === 1 && !readdirSync(ran.tmp, { recursive: true }).some(entry => String(entry).includes('copy-')), `${connections} connections; ${readdirSync(ran.tmp, { recursive: true }).slice(0, 8).join(' ')}`)
  const told = ran.sent.filter(request => request.includes('and do the work.')).map(request => request.split('is a file on another machine: Read, Edit, Write, Grep and Glob take it as a path').length - 1)
  check(`${name}: the model is told once what ssh:// is, with the prompt that named it: each of the twelve requests of the conversation holds the words once`, told.length === 12 && told.every(count => count === 1), `${told.join(' ')} in ${ran.sent.length} requests`)
}

async function untouched(world: RemoteWorld): Promise<void> {
  section('a user who names no remote path')
  const before = world.argvLines().length
  const turns = (cwd: string): Turn[] => [{ kind: 'tool_use', name: 'Read', input: { file_path: join(cwd, 'README.md') } }, { kind: 'text', text: 'Read it.' }]
  const ran = await run('plain', world, 'read the readme', turns(join(launch, 'plain', 'project')), {}, [])
  check('the run ends well', ran.code === 0 && ran.answers.length === 1 && (ran.answers[0] ?? '').includes('One line of text.'), `exit ${ran.code}; ${(ran.answers[0] ?? '').slice(0, 200)}; ${ran.stderr.slice(-200)}`)
  check('no ssh was started, of any kind', world.argvLines().length === before, world.argvLines().slice(before).join(' | '))
  check('nothing of the feature is in any request: not a word about ssh://', !ran.raw.includes('ssh://'), `${ran.raw.indexOf('ssh://')}`)
  check('and no folder of it was made', !existsSync(join(ran.tmp, 'remote-files')) && !readdirSync(ran.tmp, { recursive: true }).some(entry => String(entry).includes('remote-files')), readdirSync(ran.tmp, { recursive: true }).slice(0, 8).join(' '))
}

try {
  if (!existsSync(DIST)) {
    console.log(`  [FAIL] there is no built product at ${DIST}: build it first`)
    failures++
    checks++
  } else {
    let plain: RemoteWorld | null = null
    for (const transport of ['sshd', 'local'] as const) {
      const unavailable = transport === 'local' ? localTransportUnavailable() : sshdUnavailable()
      if (unavailable !== null) {
        console.log(`  [SKIP] the ${transport} transport: ${unavailable}`)
        continue
      }
      const world = await remoteWorld(transport, PORT, { clientHome: HOME })
      try {
        await through(world)
        if (plain === null) {
          plain = world
          await untouched(world)
        }
      } finally {
        await world.stop()
      }
    }
    if (statSync(DIST).size === 0) check('the bundle is not empty', false)
  }
} finally {
  removeScratch(launch)
}

console.log(`\nremote files through the product: ${checks - failures} of ${checks} ${failures === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failures === 0 ? 0 : 1)
