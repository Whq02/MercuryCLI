#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const ROOT = join(import.meta.dir, '..', '..')
const PLATFORM = 'linux/amd64'
const TAG = `mercury:proof-${process.pid}`
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const skip = (why: string): never => {
  console.log(`  [SKIP] headless image drive: ${why}`)
  process.exit(0)
}
const docker = (args: string[], timeoutMs = 180_000): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? String(r.error) : (r.stderr ?? '') }
}
type Run = { code: number | null; out: string; err: string; ms: number }
const dockerRun = (args: string[], onStart?: () => void, timeoutMs = 180_000): Promise<Run> => new Promise(resolve => {
  const t0 = Date.now()
  const child = spawn('docker', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { err += d })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  child.on('close', code => { clearTimeout(timer); resolve({ code, out, err, ms: Date.now() - t0 }) })
  if (onStart) child.on('spawn', onStart)
})

console.log('headless image drive — docker build, then the image run against the fixture provider')
const info = docker(['info', '--format', '{{.ServerVersion}} {{.Architecture}}'], 30_000)
if (info.status !== 0) skip(`Docker is not reachable on this machine (docker info: ${(info.stderr || info.stdout).trim().split('\n')[0] ?? 'no answer'})`)
console.log(`  docker engine ${info.stdout.trim()} · building ${TAG} for ${PLATFORM}`)

const hostRoad = process.platform === 'linux'
  ? { network: ['--network', 'host'], hostName: '127.0.0.1' }
  : { network: [] as string[], hostName: 'host.docker.internal' }

const buildStarted = Date.now()
const build = docker(['build', '--platform', PLATFORM, '-t', TAG, '.'], 45 * 60_000)
const buildSecs = Math.round((Date.now() - buildStarted) / 1000)
check(`docker build --platform ${PLATFORM} succeeds (${buildSecs}s)`, build.status === 0, build.stderr.split('\n').filter(l => /error|ERROR/.test(l)).slice(-6).join(' | '))
if (build.status !== 0) {
  console.log('\nheadless image drive: RED')
  process.exit(1)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'headless-image-drive-')))
const containers: string[] = []
try {
  const inspect = docker(['image', 'inspect', TAG, '--format', '{{.Architecture}}|{{.Os}}|{{.Config.User}}|{{.Config.WorkingDir}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}'])
  const [arch, os, user, workdir, entrypoint, cmd] = inspect.stdout.trim().split('|')
  check('the image is linux/amd64', arch === 'amd64' && os === 'linux', inspect.stdout.trim())
  check('the image runs as the non-root user mercury in /work with ENTRYPOINT ["mercury"] CMD ["run"]', user === 'mercury' && workdir === '/work' && entrypoint === '["mercury"]' && cmd === '["run"]', inspect.stdout.trim())

  const version = await dockerRun(['run', '--rm', '--platform', PLATFORM, TAG, '--version'])
  check(`docker run <image> --version prints Mercury ${VERSION} and exits 0 (${version.ms}ms)`, version.code === 0 && version.out.trim() === `Mercury ${VERSION}` && version.err === '', JSON.stringify(version))

  const payload = await dockerRun(['run', '--rm', '--platform', PLATFORM, '--entrypoint', 'sh', TAG, '-c', 'ls /opt/mercury; id -u; test -x /opt/mercury/vendor/node/bin/node && echo node-ok; command -v git rg >/dev/null 2>&1; echo git=$(command -v git); echo rg=$(ls /opt/mercury/vendor/ripgrep)'])
  const members = payload.out.split('\n').map(l => l.trim())
  check('the runtime payload carries the bundle, its manifest and the vendored runtime', members.includes('mercury.mjs') && members.includes('manifest.json') && members.includes('vendor') && members.includes('node-ok'), payload.out)
  check('the runtime payload carries no enter screen (splash.mjs, splash-core.mjs absent)', !members.includes('splash.mjs') && !members.includes('splash-core.mjs'), payload.out)
  check('the container user is uid 1000 and git is installed', members.includes('1000') && members.some(l => l.startsWith('git=/')), payload.out)

  const work = join(scratch, 'work')
  mkdirSync(work)
  writeFileSync(join(work, 'README.md'), 'The fixture project: a small library that greets.\n')
  const before = readdirSync(work).sort()
  const turns: ScriptedTurn[] = [
    { kind: 'text', text: 'The fixture answered from inside the container.' },
    { kind: 'text', text: 'The fixture answered the root run.' },
    { kind: 'hang', deltas: ['The turn is open.'] },
  ]
  const api = await startFixtureApi(turns)
  const base = `http://${hostRoad.hostName}:${new URL(api.url).port}`
  const common = ['--platform', PLATFORM, ...hostRoad.network, '-e', `ANTHROPIC_BASE_URL=${base}`, '-v', `${work}:/work`]
  const key = ['-e', 'ANTHROPIC_API_KEY=proof-key-ci-gate-not-a-real-key']
  try {
    const name = `headless-image-drive-${process.pid}`
    containers.push(name)
    const run = await dockerRun(['run', '--name', name, ...common, ...key, TAG, 'run', 'Summarise this repository in one line.', '--format', 'text'])
    check(`the keyed run answers the fixture's text and exits 0 (${run.ms}ms)`, run.code === 0 && run.out === 'The fixture answered from inside the container.\n' && run.err === '', JSON.stringify(run))
    check('the run reached the provider once through the container network', api.messageRequests().length === 1, String(api.messageRequests().length))
    const diff = docker(['diff', name])
    const changed = diff.stdout.split('\n').filter(l => l !== '').map(l => l.slice(2))
    const outside = changed.filter(p => !(p === '/home' || p === '/home/mercury' || p.startsWith('/home/mercury/') || p === '/tmp' || p.startsWith('/tmp/')))
    check('the run wrote only under the container home and /tmp (docker diff)', changed.length > 0 && outside.length === 0, outside.join(', ') || diff.stderr)
    check('the mounted tree is untouched by a read-only prompt', JSON.stringify(readdirSync(work).sort()) === JSON.stringify(before), readdirSync(work).join(', '))

    const noKey = await dockerRun(['run', '--rm', ...common, TAG, 'run', 'Summarise this repository in one line.', '--format', 'text'])
    const noKeyLines = noKey.err.split('\n').filter(l => l !== '')
    check(`a run with no key refuses in one plain stderr line and exits 1 (${noKey.ms}ms)`, noKey.code === 1 && noKey.out === '' && noKeyLines.length === 1, JSON.stringify(noKey))
    check('the no-key run never reached the provider', api.messageRequests().length === 1, String(api.messageRequests().length))

    const root = await dockerRun(['run', '--rm', '--user', '0', ...common, ...key, TAG, 'run', 'Summarise this repository in one line.', '--format', 'text', '--sovereign'])
    const rootLines = root.err.split('\n').filter(l => l !== '')
    check(`a root run in sovereign mode carries the product's one root notice on stderr and continues (${root.ms}ms)`, root.code === 0 && root.out === 'The fixture answered the root run.\n' && rootLines.length === 1 && /root/.test(rootLines[0] ?? '') && /sovereign/.test(rootLines[0] ?? ''), JSON.stringify(root))

    const hangName = `headless-image-drive-stop-${process.pid}`
    containers.push(hangName)
    const stopped = { at: 0, rc: -1 }
    const hang = dockerRun(['run', '--name', hangName, ...common, ...key, TAG, 'run', 'Keep the turn open.', '--format', 'rows'])
    await api.messageRequestStarted(3)
    const stopStarted = Date.now()
    const stop = docker(['stop', '-t', '20', hangName], 60_000)
    stopped.at = Date.now() - stopStarted
    stopped.rc = stop.status ?? -1
    const hung = await hang
    const rows = hung.out.trim().split('\n').map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return {} } })
    const exitCode = docker(['inspect', hangName, '--format', '{{.State.ExitCode}}']).stdout.trim()
    check(`docker stop reaches the run as SIGTERM: exit 143 with the interrupted outcome flushed (stop ${stopped.at}ms, run ${hung.ms}ms)`, stopped.rc === 0 && exitCode === '143' && rows.at(-1)?.type === 'outcome' && rows.at(-1)?.status === 'interrupted', JSON.stringify({ exitCode, last: rows.at(-1), err: hung.err }))
  } finally {
    await api.close()
  }
} finally {
  for (const name of containers) docker(['rm', '-f', name], 60_000)
  docker(['rmi', TAG], 60_000)
  rmSync(scratch, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nheadless image drive: RED (${failures})`)
  process.exit(1)
}
console.log('\nheadless image drive: green')
