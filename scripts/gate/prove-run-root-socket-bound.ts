import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(process.env.PROOF_SUBJECT_ROOT ?? join(import.meta.dir, '../..'))
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the proof run root keeps the daemon socket within the bound')
console.log('============================================================')

const productBound = Number(/SUN_PATH_SAFE_MAX = (\d+)/.exec(readFileSync(join(root, 'src/daemon/controlSocket.ts'), 'utf8'))?.[1])
const runnerBound = Number(/^suite_socket_bound=(\d+)$/m.exec(readFileSync(join(root, 'scripts/lib/suite-env.sh'), 'utf8'))?.[1])
check("the runner budgets the preferred socket path against the product's own bound", Number.isInteger(productBound) && runnerBound === productBound, `product ${productBound}, runner ${Number.isNaN(runnerBound) ? 'none' : runnerBound}`)

const socketPathUnder = (base: string): string => `${base}/mercury-proof-run.XXXXXX/config-home/daemon/control.sock`
const fits = (base: string): boolean => Buffer.byteLength(socketPathUnder(base), 'utf8') <= productBound

const world = mkdtempSync(join(tmpdir(), 'run-root-bound-'))
const outside: string[] = []
const subject = join(world, 'subject.ts')
writeFileSync(subject, `import { mkdirSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { controlSockPath, daemonDir } = await import(${JSON.stringify(join(root, 'src/daemon/controlSocket.ts'))})
const { startControlServer } = await import(${JSON.stringify(join(root, 'src/daemon/controlServer.ts'))})
mkdirSync(daemonDir(), { recursive: true })
const preferred = join(daemonDir(), 'control.sock')
const sock = controlSockPath()
const ping = (path: string): Promise<string> => new Promise(resolve => {
  let reply = ''
  const client = net.createConnection(path)
  const timer = setTimeout(() => client.destroy(), 5000)
  client.on('connect', () => client.write(JSON.stringify({ op: 'ping' }) + '\\n'))
  client.on('data', chunk => { reply += chunk.toString() })
  client.on('error', () => {})
  client.on('close', () => { clearTimeout(timer); resolve(reply) })
})
let outcome = 'listening'
let reply = ''
try {
  const handle = await startControlServer({} as never)
  reply = await ping(sock)
  await handle.close()
} catch (error) {
  outcome = String((error as { message?: string }).message ?? error)
}
const answered = reply.includes('"op":"ping"')
console.log(JSON.stringify({ home: process.env.MERCURY_CONFIG_DIR ?? null, preferred, bytes: Buffer.byteLength(preferred, 'utf8'), sock, outcome, answered }))
process.exit(outcome === 'listening' && answered ? 0 : 1)
`)
mkdirSync(join(world, 'synth'))
const runner = join(world, 'synth', 'run-all.sh')
writeFileSync(runner, `#!/usr/bin/env bash\n# gate-class: pure\nset -u\n. ${JSON.stringify(join(root, 'scripts/lib/suite-env.sh'))} || exit 78; suite_env_guard "$0"\ncd ${JSON.stringify(root)} || exit 1\n${JSON.stringify(process.execPath)} ${JSON.stringify(subject)}\n`)

type Reading = { home: string | null; preferred: string; bytes: number; sock: string; outcome: string; answered: boolean }
type Leg = { name: string; base: string; words: string }

const legs: Leg[] = []
if (process.platform === 'darwin') {
  legs.push({ name: 'default', base: execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim(), words: "the box's own default temp dir (launchd's, a trailing slash, spelled through /var)" })
} else {
  const shaped = join(world, 'private', 'var', 'folders', 'xx', 'y'.repeat(30), 'T')
  mkdirSync(shaped, { recursive: true })
  symlinkSync(join(world, 'private', 'var'), join(world, 'var'))
  legs.push({ name: 'default', base: `${join(world, 'var', 'folders', 'xx', 'y'.repeat(30), 'T')}/`, words: 'a temp dir shaped like the macOS default (a trailing slash, spelled through a symlink)' })
}
const deepParent = join(world, 'deep')
const deep = join(deepParent, 'x'.repeat(Math.max(1, 90 - deepParent.length - 1)))
mkdirSync(deep, { recursive: true })
legs.push({ name: 'deep', base: `${deep}/`, words: `a deliberately deep temp dir (${deep.length} chars)` })
const short = mkdtempSync('/tmp/run-root-bound-')
outside.push(short)
legs.push({ name: 'short', base: short, words: `a short temp dir (${short.length} chars)` })

try {
  for (const leg of legs) {
    console.log(`\n── ${leg.name}: TMPDIR=${leg.base} — ${leg.words}`)
    const honoured = fits(realpathSync(leg.base))
    const expectedBase = honoured ? realpathSync(leg.base) : realpathSync('/tmp')
    const dir = join(world, `leg-${leg.name}`)
    mkdirSync(dir)
    const { MERCURY_CONFIG_DIR: _home, MERCURY_HOME: _mercuryHome, ...env } = process.env as Record<string, string>
    const res = spawnSync('bash', [join(root, 'scripts/gate/run-suite.sh'), runner, '120', dir], { cwd: root, env: { ...env, TMPDIR: leg.base }, encoding: 'utf8', timeout: 180_000 })
    const out = existsSync(join(dir, 'synth.out')) ? readFileSync(join(dir, 'synth.out'), 'utf8') : ''
    const rc = existsSync(join(dir, 'synth.rc')) ? readFileSync(join(dir, 'synth.rc'), 'utf8').trim() : `no rc file (runner status ${res.status})`
    const header = /^suite synth: proof run root (\S+) \((.*)\)$/.exec(out.split('\n')[0] ?? '')
    const reading = out.split('\n').map(line => { try { return JSON.parse(line) as unknown } catch { return null } }).filter((v): v is Reading => v !== null && typeof v === 'object' && 'sock' in v).pop()
    const runRoot = header?.[1] ?? ''
    const note = header?.[2] ?? ''
    check('the suite header names the run root and why its base was chosen', header !== null, out.split('\n')[0]?.slice(0, 200) ?? '(no output)')
    check(`the run root is spelled canonically under ${honoured ? 'the inherited TMPDIR' : 'the /tmp fallback'} (${expectedBase})`, runRoot.startsWith(`${expectedBase}/mercury-proof-run.`) && !runRoot.includes('//'), runRoot || '(no run root named)')
    check(`the note ${honoured ? 'says the inherited TMPDIR fits' : `says the inherited TMPDIR overflows the ${productBound}-byte bound and names the fallback`}`, honoured ? new RegExp(`TMPDIR \\S+ keeps the daemon socket path at \\d+ bytes, within the ${productBound}-byte bound`).test(note) : new RegExp(`TMPDIR \\S+ would put the daemon socket path at \\d+ bytes, past the ${productBound}-byte bound; fallback /tmp keeps`).test(note), note.slice(0, 260))
    check("the run root's preferred socket path fits the bound", reading !== undefined && reading.bytes <= productBound && reading.home !== null && reading.preferred === join(reading.home, 'daemon', 'control.sock'), reading ? `${reading.preferred} (${reading.bytes} bytes)` : 'no reading')
    check('the daemon listens on its preferred path, not a fallback', reading !== undefined && reading.sock === reading.preferred, reading ? `${reading.sock} (${reading.outcome})` : 'no reading')
    check('the daemon answers a ping through the run root (rc 0)', rc === '0' && reading?.answered === true, `rc=${rc}${reading ? `; ${reading.outcome}` : ''}`)
    check('the run root is gone after the suite', runRoot !== '' && !existsSync(runRoot), runRoot || '(no run root named)')
  }
} finally {
  rmSync(world, { recursive: true, force: true })
  for (const p of outside) rmSync(p, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL RUN-ROOT SOCKET-BOUND CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
