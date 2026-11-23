#!/usr/bin/env bun
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { FLAG_REGISTRY } from '../../src/platform/substrate/flagRegistry.ts'
import { builtCli, fixtureCli, withLiveRunner } from '../lib/builtProduct.ts'
import { nodeBinPath } from '../lib/nodeBin.ts'

const SELF = import.meta.path
const POSIX = process.platform !== 'win32'
const PLANTED_BUNDLE = `import { spawn } from 'node:child_process'
const [verb, ...rest] = process.argv.slice(2)
if (verb === 'runner') {
  const child = rest.includes('--with-child') ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : null
  process.stderr.write(JSON.stringify({ pid: process.pid, child: child === null ? null : child.pid, cwd: process.cwd(), env: process.env }) + '\\n')
  if (rest.includes('--stubborn')) setInterval(() => {}, 1000)
  else {
    process.stdin.resume()
    process.stdin.on('end', () => process.exit(0))
  }
} else {
  process.stdout.write(JSON.stringify({ argv: [verb, ...rest], cwd: process.cwd(), env: process.env }))
}
`

type Dump = { argv: string[]; cwd: string; env: Record<string, string> }
type Boot = { pid: number; child: number | null; cwd: string; env: Record<string, string> }
type Held = { proof: number; runner: number; child: number; parent: string }

function git(tree: string, args: string[]): string {
  return execFileSync('git', args, { cwd: tree, encoding: 'utf8' }).trim()
}

function build(tree: string): void {
  git(tree, ['add', '-A'])
  git(tree, ['-c', 'user.email=built-product@proof', '-c', 'user.name=built-product', 'commit', '-q', '--allow-empty', '-m', 'the planted tree'])
  mkdirSync(join(tree, 'dist'), { recursive: true })
  writeFileSync(join(tree, 'dist', 'mercury.mjs'), PLANTED_BUNDLE)
  writeFileSync(join(tree, 'dist', 'manifest.json'), JSON.stringify({ buildTree: git(tree, ['rev-parse', 'HEAD^{tree}']) }))
}

function plant(work: string, name: string): string {
  const tree = join(work, name)
  mkdirSync(join(tree, 'product'), { recursive: true })
  writeFileSync(join(tree, '.gitignore'), 'dist/\n')
  writeFileSync(join(tree, 'product', 'entry.ts'), 'export const entry = 1\n')
  git(tree, ['init', '-q', '-b', 'main'])
  build(tree)
  return tree
}

function bootOf(stderr: string): Boot | null {
  const line = stderr.split('\n').find(text => text.startsWith('{'))
  if (line === undefined) return null
  try {
    return JSON.parse(line) as Boot
  } catch {
    return null
  }
}

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (!POSIX) return true
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return state !== '' && !state.startsWith('Z')
  } catch {
    return false
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  for (const until = Date.now() + ms; Date.now() < until; await pause(50)) if (!alive(pid)) return true
  return !alive(pid)
}

if (process.argv[2] === '--dump') {
  const ran = builtCli(['dump'], { tree: process.argv[3]! })
  console.log(JSON.stringify({ status: ran.status, parent: dirname((JSON.parse(ran.stdout) as Dump).cwd) }))
  process.exit(0)
}

if (process.argv[2] === '--no-scratch') {
  const tree = process.argv[3]!
  const { Server } = await import('node:http')
  const { listen, close } = Server.prototype as unknown as Record<'listen' | 'close', (...args: unknown[]) => unknown>
  let opened = 0
  let listening = 0
  Object.assign(Server.prototype, {
    listen(this: unknown, ...args: unknown[]) {
      opened++
      listening++
      return listen.apply(this, args)
    },
    close(this: unknown, ...args: unknown[]) {
      listening--
      return close.apply(this, args)
    },
  })
  const ran = await fixtureCli([{ kind: 'text', text: 'ok' }], ['dump'], { tree })
  rmSync(dirname((JSON.parse(ran.stdout) as Dump).cwd), { recursive: true, force: true })
  const refused = await fixtureCli([{ kind: 'text', text: 'ok' }], ['dump'], { tree }).then(() => '', (error: Error) => error.message)
  console.log(JSON.stringify({ refused, opened, listening }))
  process.exit(0)
}

if (process.argv[2] === '--hold') {
  const [tree, out, how] = process.argv.slice(3) as [string, string, string]
  await withLiveRunner(
    async runner => {
      let boot: Boot | null = null
      for (const until = Date.now() + 20_000; boot === null && Date.now() < until; await pause(25)) boot = bootOf(runner.stderr())
      if (boot === null) throw new Error('the planted runner never said where it stands')
      writeFileSync(join(out, 'held.json'), JSON.stringify({ proof: process.pid, runner: boot.pid, child: boot.child, parent: dirname(boot.cwd) }))
      if (how === 'exit') process.exit(3)
      await pause(60_000)
    },
    { tree, initialize: false, argv: ['--stubborn', '--with-child'] },
  )
  process.exit(0)
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
function thrown(run: () => unknown): string {
  try {
    run()
    return ''
  } catch (error) {
    return (error as Error).message
  }
}

const work = realpathSync(mkdtempSync(join(tmpdir(), 'built-product-proof-')))
const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}
const started: number[] = []
const fresh = plant(work, 'fresh')
const stale = plant(work, 'stale')
writeFileSync(join(stale, 'product', 'entry.ts'), 'export const entry = 2\n')
const unbuilt = join(work, 'unbuilt')
mkdirSync(unbuilt, { recursive: true })
const again = (args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } => {
  const ran = spawnSync(process.execPath, [SELF, ...args], { env, encoding: 'utf8', timeout: 120_000 })
  return { status: ran.status, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

try {
  section('§1 a bundle older than its tree is refused, and the refusal says what to do')
  const own = builtCli(['dump', 'two words'], { tree: fresh })
  const dump = JSON.parse(own.stdout) as Dump
  check('a bundle built from its tree runs: the planted bundle answers with its arguments', own.status === 0 && JSON.stringify(dump.argv) === JSON.stringify(['dump', 'two words']), own.stdout.slice(0, 200))
  const refusal = thrown(() => builtCli(['dump'], { tree: stale }))
  check('a tree with a source file changed since the build is refused, and the refusal names the file', refusal.includes('1 build input changed since: product/entry.ts'), refusal)
  check('…and says to build first, where, and to run the proof again', refusal.includes('build first') && refusal.includes(`\`bun run build.ts\` in ${stale}`) && refusal.includes('run this proof again'), refusal)
  const absent = thrown(() => builtCli(['dump'], { tree: unbuilt }))
  check('a tree with no bundle is refused with the same instruction', absent.includes(`${join(unbuilt, 'dist', 'mercury.mjs')} is absent`) && absent.includes('`bun run build.ts`'), absent)
  const alone = again(['--dump', stale])
  check('a proof process alone on the stale tree ends red and prints the refusal on stderr', alone.status !== 0 && alone.stderr.includes('1 build input changed since: product/entry.ts') && alone.stderr.includes('build first'), `rc ${alone.status} · ${alone.stderr.slice(0, 300)}`)
  build(stale)
  const stillRefused = thrown(() => builtCli(['dump'], { tree: stale }))
  const rebuilt = again(['--dump', stale])
  check('the tree is asked once per process: after a build this process keeps its verdict and a new process runs the bundle', stillRefused === refusal && rebuilt.status === 0 && rebuilt.stdout.includes('"status":0'), `here: ${stillRefused.slice(0, 80)} · new process: rc ${rebuilt.status} ${rebuilt.stdout.slice(0, 120)} ${rebuilt.stderr.slice(0, 200)} · bundle() and judged() in scripts/lib/builtProduct.ts must keep one verdict per tree per process and judge a fresh process against the rebuilt bundle`)

  section('§2 a child gets the scratch home and nothing else of the proof')
  const planted = { ANTHROPIC_API_KEY: 'the-proof-holds-this-key', MERCURY_PLANTED_FLAG: '1', PLANTED_WORD: 'ambient', MERCURY_OPENAI_API_BASE: 'http://ambient.invalid', ANTHROPIC_BASE_URL: 'http://ambient.invalid' }
  const before = Object.fromEntries(Object.keys(planted).map(name => [name, process.env[name]]))
  Object.assign(process.env, planted)
  const cli = JSON.parse(builtCli(['dump'], { tree: fresh, env: { PASSED_BY_THE_PROOF: 'yes', MERCURY_NPM_REGISTRY_BASE: 'http://127.0.0.1:2' } }).stdout) as Dump
  const runnerBoot = await withLiveRunner(async runner => {
    for (const until = Date.now() + 20_000; Date.now() < until; await pause(25)) {
      const boot = bootOf(runner.stderr())
      if (boot !== null) return boot
    }
    return null
  }, { tree: fresh, initialize: false })
  for (const [name, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  const bare = Object.keys(JSON.parse(spawnSync(nodeBinPath(), ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { HOME: work, MERCURY_CONFIG_DIR: join(work, 'no-home'), MERCURY_LOCAL_PROBE_TARGETS: 'none' }, encoding: 'utf8' }).stdout || '{}') as Record<string, string>)
  const bases = FLAG_REGISTRY.map(row => row.env).filter(name => /^(?:MERCURY_UPDATE_API_BASE_URL|MERCURY_[A-Z0-9_]+_BASE)$/.test(name))
  const allowed = new Set(['PATH', 'TMPDIR', 'NODE_COMPILE_CACHE', 'HOME', 'TERM', 'MERCURY_CONFIG_DIR', 'MERCURY_DAEMON_DIR', 'MERCURY_LOCAL_PROBE_TARGETS', 'MERCURY_CREDENTIAL_STORE', 'ANTHROPIC_BASE_URL', ...bases, ...bare])
  const strangers = (env: Record<string, string>, passed: string[] = []): string[] => Object.keys(env).filter(name => !allowed.has(name) && !passed.includes(name))
  check('the CLI child carries the scratch names, the declared bases, PATH and what the proof passed: no other name', strangers(cli.env, ['PASSED_BY_THE_PROOF']).length === 0, `${strangers(cli.env, ['PASSED_BY_THE_PROOF']).join(' ')} · cliEnv and scratchEnv in scripts/lib/builtProduct.ts must pass only PATH, the scratch names, the dead bases and what the drive passes; remove these names there, or add one that is meant to pass to this check's allowed list`)
  check('the runner child carries the same names and no other', runnerBoot !== null && strangers(runnerBoot.env).length === 0, `${runnerBoot === null ? 'the planted runner never spoke' : strangers(runnerBoot.env).join(' ')} · withLiveRunner in scripts/lib/builtProduct.ts and hostRunner in scripts/lib/runnerHost.ts must give the runner only the scratch environment`)
  check("the proof's key, its flags and its words stay with the proof", [cli.env, runnerBoot?.env ?? {}].every(env => env.ANTHROPIC_API_KEY === undefined && env.MERCURY_PLANTED_FLAG === undefined && env.PLANTED_WORD === undefined), `${JSON.stringify({ cli: cli.env.ANTHROPIC_API_KEY, runner: runnerBoot?.env.ANTHROPIC_API_KEY })} · cliEnv in scripts/lib/builtProduct.ts must not copy the proof's own environment into a child; only PATH, TMPDIR and NODE_COMPILE_CACHE pass`)
  check('what the proof passes arrives', cli.env.PASSED_BY_THE_PROOF === 'yes' && cli.env.MERCURY_NPM_REGISTRY_BASE === 'http://127.0.0.1:2', 'the env passed to builtCli did not reach the child; scratchEnv in scripts/lib/builtProduct.ts must apply the drive\'s env last')
  check('the credential store is the file store, for the CLI and for the runner', cli.env.MERCURY_CREDENTIAL_STORE === 'file' && runnerBoot?.env.MERCURY_CREDENTIAL_STORE === 'file', `${cli.env.MERCURY_CREDENTIAL_STORE} ${runnerBoot?.env.MERCURY_CREDENTIAL_STORE} · scratchEnv in scripts/lib/builtProduct.ts must set MERCURY_CREDENTIAL_STORE to file`)
  check(
    "the home, the config home and the daemon folder are the child's scratch, never the proof's",
    [cli.env, runnerBoot?.env ?? {}].every(env => env.HOME !== undefined && env.HOME !== process.env.HOME && env.MERCURY_CONFIG_DIR === join(env.HOME, '.mercury') && env.MERCURY_CONFIG_DIR !== process.env.MERCURY_CONFIG_DIR && env.MERCURY_DAEMON_DIR === join(env.HOME, 'daemon')),
    `${JSON.stringify({ cli: cli.env.MERCURY_CONFIG_DIR, runner: runnerBoot?.env.MERCURY_CONFIG_DIR })} · scratchHome in scripts/lib/runnerHost.ts, used by scratch() in scripts/lib/builtProduct.ts, must give each child its own HOME with the config home and daemon folder inside it`,
  )
  check('the CLI child keeps the PATH of the proof; on a POSIX host the runner gets the system folders and the folder of its node', cli.env.PATH === process.env.PATH && (!POSIX || runnerBoot?.env.PATH === `/usr/bin:/bin:${dirname(nodeBinPath())}`), `${runnerBoot?.env.PATH} · cliEnv in scripts/lib/builtProduct.ts must pass the proof's PATH to the CLI child; the runner's PATH comes from hostRunner in scripts/lib/runnerHost.ts`)

  section('§3 every base the product declares is a dead address unless the proof sets it')
  const declared = ['ANTHROPIC_BASE_URL', ...bases]
  const dead = new Set(declared.filter(name => name !== 'MERCURY_NPM_REGISTRY_BASE').map(name => cli.env[name]))
  const address = [...dead][0] ?? ''
  check(`the registry declares the bases: ${bases.length} rows the suite guard admits, the registry base among them`, bases.length >= 30 && bases.includes('MERCURY_NPM_REGISTRY_BASE') && bases.includes('MERCURY_UPDATE_API_BASE_URL'), `${bases.length} bases · FLAG_REGISTRY in the flag registry must declare the *_BASE env rows (MERCURY_NPM_REGISTRY_BASE and MERCURY_UPDATE_API_BASE_URL among them) that deadBases() in scripts/lib/builtProduct.ts points at a dead address`)
  check('each of them, and the Anthropic base, reaches the CLI child as one loopback address', dead.size === 1 && /^http:\/\/127\.0\.0\.1:\d+$/.test(address), [...dead].join(' '))
  check('…and the runner child as the same address, the registry base included', runnerBoot !== null && declared.every(name => runnerBoot.env[name] === address), declared.filter(name => runnerBoot?.env[name] !== address).join(' '))
  check('a base the environment of the proof names is not handed on: the child gets the dead address', cli.env.MERCURY_OPENAI_API_BASE === address && cli.env.ANTHROPIC_BASE_URL === address, `${cli.env.MERCURY_OPENAI_API_BASE} ${cli.env.ANTHROPIC_BASE_URL} · scratchEnv in scripts/lib/builtProduct.ts must start from deadBases() and never copy a base from the proof's own environment`)
  check('the two operator slots stay unset: a base there would configure an endpoint', cli.env.MERCURY_COMPAT_BASE_URL === undefined && cli.env.MERCURY_LOCAL_BASE_URL === undefined, `${cli.env.MERCURY_COMPAT_BASE_URL} ${cli.env.MERCURY_LOCAL_BASE_URL} · the BASE pattern in scripts/lib/builtProduct.ts must not match MERCURY_COMPAT_BASE_URL or MERCURY_LOCAL_BASE_URL`)
  const refusedBy = await new Promise<string>(done => {
    const url = new URL(address || 'http://127.0.0.1:1')
    const socket = connect({ host: url.hostname, port: Number(url.port) })
    const ceiling = setTimeout(() => {
      socket.destroy()
      done('no answer in 5 s')
    }, 5_000)
    socket.once('connect', () => {
      clearTimeout(ceiling)
      socket.destroy()
      done('')
    })
    socket.once('error', error => {
      clearTimeout(ceiling)
      done(error.message)
    })
  })
  check('nothing listens at that address', refusedBy !== '', `a connection to ${address} was taken`)

  section('§4 the scratch goes: one parent folder for the process, removed with it')
  const second = JSON.parse(builtCli(['dump'], { tree: fresh }).stdout) as Dump
  check('the folder a CLI child ran in and its home are gone when the call returns', !existsSync(cli.cwd) && !existsSync(cli.env.HOME!) && !existsSync(second.cwd) && !existsSync(second.env.HOME!), `${cli.cwd} ${second.cwd} · builtCli in scripts/lib/builtProduct.ts must call dropScratch when the call returns`)
  check('the folder and the home of the runner are gone when its callback returns', runnerBoot !== null && !existsSync(runnerBoot.cwd) && !existsSync(runnerBoot.env.HOME!), `${runnerBoot?.cwd} · withLiveRunner in scripts/lib/builtProduct.ts must call dropScratch when its callback returns`)
  check('every scratch of this process sat under one parent folder', new Set([cli.cwd, cli.env.HOME!, second.cwd, second.env.HOME!, runnerBoot?.cwd ?? '', runnerBoot?.env.HOME ?? ''].map(path => real(dirname(path)))).size === 1 && basename(dirname(cli.cwd)).startsWith('built-product-') && existsSync(dirname(cli.cwd)), dirname(cli.cwd))
  const other = again(['--dump', fresh])
  const otherParent = (JSON.parse(other.stdout || '{}') as { parent?: string }).parent ?? ''
  check('a process that ends takes its parent folder with it', other.status === 0 && basename(otherParent).startsWith('built-product-') && real(otherParent) !== real(dirname(cli.cwd)) && !existsSync(otherParent), `${otherParent} · rc ${other.status} ${other.stderr.slice(0, 200)}`)

  const unmade = again(['--no-scratch', fresh])
  const drive = JSON.parse(unmade.stdout.trim().split('\n').at(-1) || '{}') as { refused?: string; opened?: number; listening?: number }
  check('a drive whose scratch cannot be made is refused with the reason and leaves no fixture server listening', unmade.status === 0 && (drive.refused ?? '').includes('ENOENT') && (drive.opened ?? 0) >= 1 && drive.listening === 0, `${unmade.stdout.slice(0, 300)} ${unmade.stderr.slice(0, 200)}`)

  section('§5 a proof that is ended takes its runner with it')
  if (!POSIX) console.log('  [SKIP] signals, process groups and the ledger reader are POSIX: not run on this host')
  else {
    const held = async (name: string, how: string, ledger: string | null): Promise<{ at: Held | null; holder: ReturnType<typeof spawn>; ended: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; temp: string; stderr: () => string }> => {
      const temp = join(work, `run-${name}`)
      const out = join(work, `out-${name}`)
      mkdirSync(temp, { recursive: true })
      mkdirSync(out, { recursive: true })
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temp, MERCURY_TMPDIR: temp, MERCURY_SUITE_TMPDIR: temp }
      delete env.MERCURY_PROCESS_LEDGER_DIR
      if (ledger !== null) env.MERCURY_PROCESS_LEDGER_DIR = ledger
      const holder = spawn(process.execPath, [SELF, '--hold', fresh, out, how], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      holder.stderr!.on('data', chunk => (stderr += String(chunk)))
      const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => holder.once('exit', (code, signal) => done({ code, signal })))
      let at: Held | null = null
      for (const until = Date.now() + 60_000; at === null && Date.now() < until && holder.exitCode === null && holder.signalCode === null; await pause(50)) {
        if (existsSync(join(out, 'held.json'))) at = JSON.parse(readFileSync(join(out, 'held.json'), 'utf8')) as Held
      }
      if (at === null && existsSync(join(out, 'held.json'))) at = JSON.parse(readFileSync(join(out, 'held.json'), 'utf8')) as Held
      if (at !== null) started.push(at.runner, at.child)
      if (holder.pid !== undefined) started.push(holder.pid)
      return { at, holder, ended, temp, stderr: () => stderr }
    }
    const left = (temp: string): string[] => readdirSync(temp).filter(name => name.startsWith('built-product-'))
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      const run = await held(signal, 'wait', null)
      const before = run.at !== null && alive(run.at.runner) && alive(run.at.child) && existsSync(run.at.parent)
      run.holder.kill(signal)
      const end = await run.ended
      const gone = run.at !== null && (await goneWithin(run.at.runner, 5_000)) && (await goneWithin(run.at.child, 5_000))
      check(`${signal}: the runner that ignores its closed input and the child it started are ended, and the proof ends by that signal`, before && gone && end.signal === signal, JSON.stringify({ at: run.at, before, gone, end, stderr: run.stderr().slice(0, 300) }))
      check(`${signal}: the parent folder of its scratch is removed`, run.at !== null && !existsSync(run.at.parent) && left(run.temp).length === 0, left(run.temp).join(' '))
    }
    const red = await held('exit', 'exit', null)
    const redEnd = await red.ended
    check('an exit with a runner still open ends the runner and its child and removes the scratch', red.at !== null && redEnd.code === 3 && (await goneWithin(red.at.runner, 5_000)) && (await goneWithin(red.at.child, 5_000)) && !existsSync(red.at.parent), JSON.stringify({ at: red.at, redEnd, stderr: red.stderr().slice(0, 300) }))

    const ledger = join(work, 'ledger')
    const killed = await held('SIGKILL', 'wait', ledger)
    const entryPath = join(ledger, `${killed.at?.runner}.entry`)
    const entry = existsSync(entryPath) ? readFileSync(entryPath, 'utf8').replace(/\n$/, '').split('\t') : []
    const startedAt = killed.at === null ? '' : execFileSync('ps', ['-o', 'lstart=', '-p', String(killed.at.runner)], { encoding: 'utf8' }).trim()
    check('where a process ledger is set the runner is written into it: pid, owner, start time, folder, command', killed.at !== null && entry.length === 5 && entry[0] === String(killed.at.runner) && /^\d+$/.test(entry[1] ?? '') && entry[2] === startedAt && startedAt !== '' && real(dirname(entry[3] ?? '')) === real(killed.at.parent) && (entry[4] ?? '').includes(`${join(fresh, 'dist', 'mercury.mjs')} runner`), JSON.stringify(entry))
    killed.holder.kill('SIGKILL')
    await killed.ended
    await pause(500)
    const orphaned = killed.at !== null && alive(killed.at.runner) && alive(killed.at.child) && existsSync(entryPath)
    check('SIGKILL is out of reach of the proof: its runner lives on and its ledger entry stands', orphaned, JSON.stringify(killed.at))
    check('what a SIGKILL leaves is one parent folder under the temp folder of the run, for the suite to remove with its run root', left(killed.temp).length === 1 && killed.at !== null && real(join(killed.temp, left(killed.temp)[0]!)) === real(killed.at.parent), left(killed.temp).join(' '))
    for (const pid of killed.at === null ? [] : [killed.at.runner, killed.at.child]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        continue
      }
    }

    const shell = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
    const suite = join(work, 'killed-suite')
    const suiteOut = join(work, 'out-suite')
    mkdirSync(suite, { recursive: true })
    mkdirSync(suiteOut, { recursive: true })
    writeFileSync(
      join(suite, 'run-all.sh'),
      [
        '#!/usr/bin/env bash',
        'set -u',
        `${shell(process.execPath)} ${shell(SELF)} --hold ${shell(fresh)} ${shell(suiteOut)} wait &`,
        'proof=$!',
        `for tick in $(seq 1 600); do [ -s ${shell(join(suiteOut, 'held.json'))} ] && break; sleep 0.1; done`,
        `cp -R "$MERCURY_PROCESS_LEDGER_DIR" ${shell(join(suiteOut, 'ledger'))}`,
        `printf '%s' "$MERCURY_SUITE_TMPDIR" > ${shell(join(suiteOut, 'run-root'))}`,
        'kill -9 "$proof"',
        'wait "$proof" 2>/dev/null',
        'exit 0',
        '',
      ].join('\n'),
    )
    const suiteRun = spawnSync('bash', [join(import.meta.dir, 'run-suite.sh'), join(suite, 'run-all.sh'), '120', suite, '', 'fixed'], { cwd: join(import.meta.dir, '..', '..'), env: { ...process.env, BUN: process.execPath }, encoding: 'utf8', timeout: 150_000 })
    const underSuite = existsSync(join(suiteOut, 'held.json')) ? (JSON.parse(readFileSync(join(suiteOut, 'held.json'), 'utf8')) as Held) : null
    if (underSuite !== null) started.push(underSuite.runner, underSuite.child)
    const runRoot = existsSync(join(suiteOut, 'run-root')) ? readFileSync(join(suiteOut, 'run-root'), 'utf8') : ''
    const suiteEntryPath = join(suiteOut, 'ledger', `${underSuite?.runner}.entry`)
    const suiteEntry = existsSync(suiteEntryPath) ? readFileSync(suiteEntryPath, 'utf8').replace(/\n$/, '').split('\t') : []
    const suiteWords = existsSync(join(suite, 'killed-suite.out')) ? readFileSync(join(suite, 'killed-suite.out'), 'utf8') : ''
    check("under a suite runner the runner stands in the suite's own ledger, in a folder under the suite's run root", underSuite !== null && runRoot !== '' && suiteEntry.length === 5 && suiteEntry[0] === String(underSuite.runner) && (suiteEntry[2] ?? '') !== '' && (suiteEntry[3] ?? '').startsWith(`${runRoot}/`) && real(underSuite.parent).startsWith(`${real(dirname(runRoot))}/`), JSON.stringify({ underSuite, runRoot, suiteEntry }))
    check("a proof killed with SIGKILL under a suite runner: the suite's own teardown ends its runner and the child it started", underSuite !== null && suiteRun.status === 0 && suiteWords.includes(`process ledger: ended ${underSuite.runner} (`) && (await goneWithin(underSuite.runner, 5_000)) && (await goneWithin(underSuite.child, 5_000)), `rc ${suiteRun.status} · ${suiteWords.slice(-400)} ${String(suiteRun.stderr).slice(0, 200)}`)
    check('…and the scratch goes with the run root of the suite', underSuite !== null && runRoot !== '' && !existsSync(runRoot) && !existsSync(underSuite.parent), runRoot)

    const tidy = await held('tidy', 'wait', ledger)
    const tidyEntry = join(ledger, `${tidy.at?.runner}.entry`)
    const written = existsSync(tidyEntry)
    tidy.holder.kill('SIGTERM')
    await tidy.ended
    check('a runner the proof ended itself leaves no entry behind for a later sweep to act on', written && !existsSync(tidyEntry))
  }
} finally {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-built-product — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
