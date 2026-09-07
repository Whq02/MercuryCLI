#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'

const REPO = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'background-probes-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the owner')
const proxy = read('src/utils/proxy.ts')
check('proxy.ts owns backgroundHttpsAgent (memoized, keepAlive off)', /export function backgroundHttpsAgent\(\)/.test(proxy) && /new BackgroundHttpsAgent\(\{ keepAlive: false \}\)/.test(proxy))
check('the agent unrefs every socket it opens (createConnection → unref)', /override createConnection\(/.test(proxy) && /\.unref\?\.\(\)/.test(proxy))

console.log('§2 the probes')
check('no policy-limits service exists (no boot-time organisation probe)', !existsSync(join(REPO, 'src/services/policyLimits')))
check('no remote managed-settings service exists (no boot-time settings fetch)', !existsSync(join(REPO, 'src/services/remoteManagedSettings')))
const rg = read('src/utils/ripgrep.ts')
check(
  'the ripgrep file-count probe unrefs its child and its pipe the moment they exist (a count never holds the exit cliff)',
  /const child = spawn\(config\.rgPath, \[\.\.\.config\.rgArgs, \.\.\.args, target\][\s\S]{0,400}\n\s*child\.unref\(\)\n[\s\S]{0,200}child\.stdout as [^\n]*\)\?\.unref\?\.\(\)/.test(rg),
)

console.log('§3 live')
{
  const { backgroundHttpsAgent } = await import('../../src/utils/proxy.ts')
  const server = createServer(() => {})
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const agent = backgroundHttpsAgent()
  const socket = (agent as unknown as { createConnection: (o: unknown) => { _handle?: { hasRef?: () => boolean }; destroy: () => void } }).createConnection({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: false })
  const handle = socket._handle
  check('a socket the agent opens reads unref’d on its handle (hasRef false) — or the host cannot say', handle === undefined || typeof handle.hasRef !== 'function' || handle.hasRef() === false, String(handle?.hasRef?.()))
  socket.destroy()
  await new Promise<void>(r => server.close(() => r()))
}

console.log('§4 the exit ends what the unref let go')
{
  const owner = await import('../../src/utils/ripgrep.ts')
  const target = join(REPO, 'node_modules')
  const marker = `background-probes-marker-${process.pid}`
  const listed = (needle: string): string => {
    const res = spawnSync('pgrep', ['-lf', needle], { encoding: 'utf8' })
    return (res.stdout ?? '').trim()
  }
  const block = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  }
  await owner.countFilesRoundedRg(SCRATCH, AbortSignal.timeout(10_000))
  const counting = owner.countFilesRoundedRg(target, AbortSignal.timeout(60_000), [`${marker}-in-process`])
  await new Promise(r => setTimeout(r, 0))
  block(100)
  const alive = listed(`${marker}-in-process`)
  const ended = owner.endLiveRipgrepChildren()
  check('the held count child is alive and the owner ends it on request (one ended)', alive !== '' && ended === 1, `ended ${ended}; listed before: ${alive || '(none)'}`)
  const answer = await counting
  check('…the count settles without an answer, never a hang', answer === undefined, String(answer))
  check('…and nothing is left to end', owner.endLiveRipgrepChildren() === 0)
  check('…the process listing agrees: the child is gone', listed(`${marker}-in-process`) === '', listed(`${marker}-in-process`))

  const script = [
    `const owner = await import(${JSON.stringify(join(REPO, 'src', 'utils', 'ripgrep.ts'))})`,
    `await owner.countFilesRoundedRg(${JSON.stringify(SCRATCH)}, AbortSignal.timeout(10_000))`,
    `void owner.countFilesRoundedRg(${JSON.stringify(target)}, AbortSignal.timeout(60_000), [${JSON.stringify(`${marker}-at-exit`)}]).catch(() => {})`,
    'await new Promise(r => setTimeout(r, 0))',
    'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)',
    'process.exit(0)',
  ].join('\n')
  const run = spawnSync(process.execPath, ['-e', script], { cwd: REPO, encoding: 'utf8', env: process.env, timeout: 30_000 })
  const leftover = listed(`${marker}-at-exit`)
  check('a process that exits while the count is still walking leaves no rg child behind', run.status === 0 && leftover === '', `exit ${String(run.status)} ${run.signal ?? ''}; leftover: ${leftover || '(none)'}; stderr: ${(run.stderr ?? '').trim().slice(0, 200)}`)
  for (const row of leftover.split('\n')) {
    const pid = Number.parseInt(row, 10)
    if (Number.isFinite(pid) && pid > 0) {
      try {
        execFileSync('kill', ['-9', String(pid)], { stdio: 'ignore' })
      } catch {
      }
    }
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures ? `\nRESULT: RED — ${failures} check(s) failed` : '\nRESULT: GREEN — the background probes never hold the exit, and the exit ends them')
process.exit(failures ? 1 : 0)
