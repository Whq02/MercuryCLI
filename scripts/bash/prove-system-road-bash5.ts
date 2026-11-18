#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at === -1 ? undefined : process.argv[at + 1]
}
const DIST = resolve(argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs'))
const LINUX_DIST = argAfter('--linux-dist')
const LINUX_IMAGE = argAfter('--linux-image') ?? 'ubuntu:24.04'
const KEEP = process.argv.includes('--keep')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const note = (text: string): void => console.log(`        note: ${text}`)

const DRIVER = String.raw`
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const arg = name => {
  const at = process.argv.indexOf(name)
  return at === -1 ? undefined : process.argv[at + 1]
}
const has = name => process.argv.includes(name)
const world = realpathSync(arg('--world'))
const ASK = 'system-road-probe'
const COMMAND = 'echo "road:$BASH_VERSION:' + '$' + '{BRUSH_VERSION:-none}:' + '$' + '{ZSH_VERSION:-none}:' + '$' + '{BASH:-none}:$SHELL"'
const KEY = 'sk-ant-fixture-' + 'k'.repeat(48)

let dist = arg('--dist')
if (has('--without-pack')) {
  const view = join(world, 'dist-without-pack')
  mkdirSync(join(view, 'vendor'), { recursive: true })
  const from = dirname(dist)
  for (const name of readdirSync(from)) {
    if (name === 'vendor') continue
    if (lstatSync(join(from, name)).isFile()) copyFileSync(join(from, name), join(view, name))
  }
  for (const name of readdirSync(join(from, 'vendor'))) {
    if (name !== 'bash') symlinkSync(join(from, 'vendor', name), join(view, 'vendor', name))
  }
  dist = join(view, 'mercury.mjs')
}

const systemBash = () => {
  for (const path of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']) {
    if (!existsSync(path)) continue
    const ran = spawnSync(path, ['--norc', '--noprofile', '-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' })
    if (ran.status === 0 && ran.stdout !== '') return { path, version: ran.stdout }
  }
  return null
}
const system = systemBash()

const hidden = []
if (has('--hide-bash')) {
  if (!existsSync('/.dockerenv')) {
    console.error('--hide-bash renames the system bash and runs only inside a container')
    process.exit(2)
  }
  for (const path of ['/usr/bin/bash', '/bin/bash', '/usr/local/bin/bash']) {
    if (!existsSync(path)) continue
    renameSync(realpathSync(path), realpathSync(path) + '.hidden-by-the-proof')
    hidden.push(path)
  }
}

const textOf = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => (part && part.type === 'text' ? part.text ?? '' : '')).join('\n') : '')
const results = []
const shellLines = new Set()
let description = ''
const sse = obj => 'data: ' + JSON.stringify(obj) + '\n\n'
const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }
let served = 0

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0]
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = {}
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const texts = [textOf(body.system)]
    const seen = []
    let lastUser = ''
    for (const message of messages) {
      if (message.role !== 'user') continue
      const text = textOf(message.content)
      texts.push(text)
      if (text.trim() !== '') lastUser = text
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) if (part && part.type === 'tool_result') seen.push({ text: textOf(part.content), isError: part.is_error === true })
    }
    const ours = lastUser.includes(ASK) || seen.length > 0
    if (ours) {
      for (const text of texts) for (const line of text.split('\n')) if (/^\s*(?:- )?Shell: /.test(line)) shellLines.add(line.trim().replace(/^- /, ''))
      const bash = (Array.isArray(body.tools) ? body.tools : []).find(tool => tool && tool.name === 'Bash')
      if (bash && typeof bash.description === 'string') description = bash.description
      for (const result of seen) if (!results.some(known => known.text === result.text)) results.push(result)
    }
    const blocks = !ours ? [{ type: 'text', text: 'ok' }] : seen.length === 0 ? [{ type: 'tool_use', name: 'Bash', input: { command: COMMAND, description: 'name the shell that runs' } }] : [{ type: 'text', text: 'done' }]
    const n = ++served
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const stop = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'
    if (body.stream !== true) {
      const content = blocks.map((block, index) => (block.type === 'text' ? block : { type: 'tool_use', id: 'toolu_road_' + n + '_' + index, name: block.name, input: block.input }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_road_' + n, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage }))
      return
    }
    const parts = ['event: message_start\n' + sse({ type: 'message_start', message: { id: 'msg_road_' + n, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } })]
    blocks.forEach((block, index) => {
      if (block.type === 'text') {
        parts.push('event: content_block_start\n' + sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }))
        parts.push('event: content_block_delta\n' + sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }))
      } else {
        parts.push('event: content_block_start\n' + sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_road_' + n + '_' + index, name: block.name, input: {} } }))
        parts.push('event: content_block_delta\n' + sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }))
      }
      parts.push('event: content_block_stop\n' + sse({ type: 'content_block_stop', index }))
    })
    parts.push('event: message_delta\n' + sse({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage }))
    parts.push('event: message_stop\n' + sse({ type: 'message_stop' }))
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(parts.join(''))
  })
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = 'http://127.0.0.1:' + server.address().port

const home = join(world, 'config-home')
const cwd = join(world, 'work')
const userHome = join(world, 'user-home')
for (const dir of [home, cwd, userHome]) mkdirSync(dir, { recursive: true })
writeFileSync(
  join(home, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: '99.0.0',
    numStartups: 10,
    theme: 'dark',
    projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
  }),
)
writeFileSync(join(home, 'settings.json'), '{}')

const env = {
  ...process.env,
  HOME: userHome,
  SHELL: '/bin/zsh',
  PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  MERCURY_CONFIG_DIR: home,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_HOME: join(home, 'proof-home'),
  MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
  ANTHROPIC_API_KEY: KEY,
  ANTHROPIC_BASE_URL: base,
  MERCURY_UPDATE_API_BASE_URL: base,
  MERCURY_ANTHROPIC_OAUTH_BASE: base,
  MERCURY_STREAM_IDLE_TIMEOUT_MS: '30000',
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_OPERATOR: 'sam',
}
for (const name of ['NODE_ENV', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_SHELL_ENGINE', 'MERCURY_SHELL_PREFIX', 'MERCURY_WINDOWS_SHELL_ROAD', 'BASH_ENV', 'ENV']) delete env[name]

const child = spawn(process.execPath, [dist, 'run', '--mode', 'sovereign', '--model', 'claude-opus-4-8', '--format', 'text', ASK], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => (stdout += String(chunk)))
child.stderr.on('data', chunk => (stderr += String(chunk)))
const ceiling = setTimeout(() => child.kill('SIGKILL'), Number(arg('--timeout') ?? 150000))
const exitCode = await new Promise(done => {
  child.once('close', code => done(code))
  child.once('error', () => done(null))
})
clearTimeout(ceiling)
await new Promise(done => server.close(() => done()))
for (const path of hidden) renameSync(realpathSync(dirname(path)) + '/bash.hidden-by-the-proof', realpathSync(dirname(path)) + '/bash')
writeFileSync(arg('--out'), JSON.stringify({ dist, exitCode, results, shellLines: [...shellLines], description, system, hidden, served, stdout: stdout.slice(-600), stderr: stderr.slice(-1200) }))
`

type Report = {
  dist: string
  exitCode: number | null
  results: Array<{ text: string; isError: boolean }>
  shellLines: string[]
  description: string
  system: { path: string; version: string } | null
  hidden: string[]
  served: number
  stdout: string
  stderr: string
}

type Lock = { version: string }
const bashLock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'bash.lock.json'), 'utf8')) as Lock
const brushLock = JSON.parse(readFileSync(join(ROOT, 'vendor', 'brush.lock.json'), 'utf8')) as Lock
const PINNED = `${bashLock.version}(1)-release`
const OLD_BASH = 'on this bash a here-document inside $( ) breaks'

const roadOf = (report: Report): { bash: string; brush: string; zsh: string; ran: string; shell: string } | null => {
  const line = report.results.map(result => result.text).join('\n').split('\n').find(text => text.startsWith('road:'))
  if (line === undefined) return null
  const [, bash = '', brush = '', zsh = '', ran = '', ...shell] = line.split(':')
  return { bash, brush, zsh, ran, shell: shell.join(':') }
}
const told = (report: Report): string => `exit ${String(report.exitCode)} · ${report.served} requests · results ${JSON.stringify(report.results.map(result => result.text.slice(0, 160)))} · stderr ${JSON.stringify(report.stderr.slice(-300))}`

type Pack = { carried: boolean; why: string }
function packOf(bundle: string): Pack {
  const manifestPath = join(dirname(bundle), 'manifest.json')
  if (!existsSync(manifestPath)) return { carried: false, why: `${manifestPath} is absent` }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bash?: { vendored?: boolean; remedy?: string } }
  return manifest.bash?.vendored === true ? { carried: true, why: '' } : { carried: false, why: manifest.bash?.remedy ?? 'its manifest records no bash pack' }
}

function judge(where: string, pack: Pack, shipped: Report, away: Report, bare: Report | null, bareWhy: string): void {
  check(
    `${where}: the bundle under proof carries the bash pack`,
    pack.carried,
    `${pack.why} — build the pack (bun run scripts/vendor/build-bash.ts, with --target <release target> for another platform), rebuild the bundle (bun run build.ts) and run this proof again; the legs on the system bash and on the engine are judged below`,
  )
  if (pack.carried) {
    const first = roadOf(shipped)
    check(`${where}: a session from the built bundle prints the pinned BASH_VERSION through the Bash tool (${PINNED})`, first?.bash === PINNED, told(shipped))
    check(`${where}: the shell that ran is the bundle's own bash ($BASH names it), and $SHELL is what the launcher had, zsh, not rewritten`, first !== null && first.ran.endsWith('/bash') && first.ran.includes('/vendor/bash/') && first.shell === '/bin/zsh' && first.zsh === 'none' && first.brush === 'none', JSON.stringify(first))
    check(`${where}: the prompt's shell line names that shell and its version`, shipped.shellLines.length === 1 && shipped.shellLines[0] === `Shell: bash ${bashLock.version}`, JSON.stringify(shipped.shellLines))
    check(`${where}: the Bash tool's description names the dialect of that shell`, shipped.description.includes('each call starts from your profile (bash).'), shipped.description.slice(-140))
  }

  const second = roadOf(away)
  const system = away.system
  check(`${where}: with the pack moved away the system's bash answers (${system ? `${system.path}, ${system.version}` : 'none found'})`, system !== null && second?.bash === system.version && /^\/(?:usr\/(?:local\/)?)?bin\/bash$/.test(second.ran) && second.shell === '/bin/zsh' && second.zsh === 'none' && second.brush === 'none', `${JSON.stringify(second)} · ${told(away)}`)
  if (system !== null) {
    const number = /^\d+(?:\.\d+)*/.exec(system.version)?.[0] ?? ''
    const old = Number(number.split('.')[0]) < 4
    check(
      `${where}: the prompt's shell line names the system bash${old ? ', with the one sentence a bash before 4.0 needs' : ''}`,
      away.shellLines.length === 1 && (old ? away.shellLines[0]!.startsWith(`Shell: bash ${number} — `) && away.shellLines[0]!.includes(OLD_BASH) : away.shellLines[0] === `Shell: bash ${number}`),
      JSON.stringify(away.shellLines),
    )
  }

  if (bare === null) {
    console.log(`  [SKIP] ${where}: the leg with no bash at all — ${bareWhy}`)
    return
  }
  const third = roadOf(bare)
  check(`${where}: with no bash that starts, the bundled engine answers (brush ${brushLock.version})`, third?.brush === brushLock.version && third.shell.includes('/vendor/brush/') && third.zsh === 'none', `${JSON.stringify(third)} · ${told(bare)}`)
  check(`${where}: the prompt's shell line names the engine`, bare.shellLines.length === 1 && bare.shellLines[0] === `Shell: brush ${brushLock.version} (bash-compatible)`, JSON.stringify(bare.shellLines))
  check(`${where}: the Bash tool's description is the engine's: one session serves the conversation`, bare.description.includes('One shell session serves the whole conversation'), bare.description.slice(0, 200))
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'system-road-')))
const driver = join(scratch, 'drive.mjs')
writeFileSync(driver, DRIVER)
const readReport = (path: string): Report | null => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Report) : null)
const empty = (why: string): Report => ({ dist: '', exitCode: null, results: [], shellLines: [], description: '', system: null, hidden: [], served: 0, stdout: '', stderr: why })

function hostLeg(name: string, flags: string[], wrap: string[] = []): Report {
  const world = join(scratch, name)
  mkdirSync(world, { recursive: true })
  const out = join(world, 'report.json')
  const argv = [...wrap, nodeBinPath(), driver, '--dist', DIST, '--world', world, '--out', out, ...flags]
  const ran = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 240_000, env: { ...process.env, TMPDIR: world } })
  return readReport(out) ?? empty(`the driver wrote no report (exit ${String(ran.status)}): ${(ran.stderr ?? '').slice(-400)}`)
}

console.log('============================================================')
console.log(' The system road runs the bash Mercury ships; then the system bash; then the engine')
console.log('============================================================')
console.log(`build under proof: ${DIST}`)

try {
  if (!existsSync(DIST)) {
    check('the built bundle is present', false, `${DIST} is absent: run bun run build.ts, then this proof again`)
  } else if (process.platform === 'win32') {
    console.log('  [SKIP] this proof drives the macOS and Linux road; the Windows road has its own proofs')
  } else {
    const shipped = hostLeg('shipped', [])
    const away = hostLeg('away', ['--without-pack'])
    let bare: Report | null = null
    let bareWhy = ''
    if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
      bare = hostLeg('no-bash', [], ['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny process-exec* (regex #"/bash$"))'])
      note('the leg with no bash runs under a sandbox profile that refuses to start any program named bash, the shipped one included')
    } else {
      bareWhy = `nothing on ${process.platform} hides the system bash from one process without changing the machine; the container leg (--linux-dist) renames it inside a container`
    }
    judge(process.platform === 'darwin' ? 'macOS' : process.platform, packOf(DIST), shipped, away, bare, bareWhy)
  }

  if (LINUX_DIST !== undefined) {
    const linuxDist = resolve(LINUX_DIST)
    const node = join(linuxDist, 'vendor', 'node', 'bin', 'node')
    const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
    if (docker.status !== 0 || !existsSync(join(linuxDist, 'mercury.mjs')) || !existsSync(node)) {
      check('the Linux container leg can run', false, `it needs a docker daemon, ${join(linuxDist, 'mercury.mjs')} and ${node} (bun run build.ts --target linux-arm64 or linux-x64 with MERCURY_BUILD_OUTDIR)`)
    } else {
      const out = join(scratch, 'linux')
      mkdirSync(out, { recursive: true })
      const leg = (name: string, flags: string[]): string => `mkdir -p /tmp/${name} && /dist/vendor/node/bin/node /drive/drive.mjs --dist /dist/mercury.mjs --world /tmp/${name} --out /out/${name}.json ${flags.join(' ')}`
      const script = [leg('shipped', []), leg('away', ['--without-pack']), leg('no-bash', ['--without-pack', '--hide-bash'])].join(' ; ')
      const ran = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${linuxDist}:/dist:ro`, '-v', `${dirname(driver)}:/drive:ro`, '-v', `${out}:/out`, LINUX_IMAGE, 'sh', '-c', script], { encoding: 'utf8', timeout: 600_000 })
      const report = (name: string): Report => readReport(join(out, `${name}.json`)) ?? empty(`the container wrote no report for ${name} (exit ${String(ran.status)}): ${(ran.stderr ?? '').slice(-400)}`)
      judge(`Linux container (${LINUX_IMAGE})`, packOf(join(linuxDist, 'mercury.mjs')), report('shipped'), report('away'), report('no-bash'), '')
    }
  } else {
    note('the Linux container legs run with --linux-dist <a dist built for linux-arm64 or linux-x64>')
  }
} finally {
  if (KEEP) console.log(`world kept: ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-system-road-bash5: ALL LAWS HOLD' : `\nprove-system-road-bash5: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
