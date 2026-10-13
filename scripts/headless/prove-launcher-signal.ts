#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const distArg = resolve(at < 0 ? join(import.meta.dir, '../../dist') : process.argv[at + 1]!)
if (!existsSync(distArg)) { console.error(`FAIL run bundle exists: ${distArg}`); process.exit(1) }
const dist = distArg.endsWith('/mercury.mjs') ? resolve(distArg, '..') : distArg

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }

const { posixLauncher, parseEnginesNode } = await import('../release/launcherTemplates.mjs') as {
  posixLauncher: (p: unknown) => string
  parseEnginesNode: (engines: string) => unknown
}
const engines = JSON.parse(readFileSync(join(import.meta.dir, '../../package.json'), 'utf8')).engines.node
const policy = parseEnginesNode(engines)

const work = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-signal-')))
const install = join(work, 'install')
mkdirSync(install, { recursive: true })
cpSync(dist, install, { recursive: true })
rmSync(join(install, 'mercury'), { force: true })
rmSync(join(install, 'mercury.cmd'), { force: true })
rmSync(join(install, 'mercury.ps1'), { force: true })
writeFileSync(join(install, 'mercury'), posixLauncher(policy))
chmodSync(join(install, 'mercury'), 0o755)
const nodeBin = process.execPath

type Leg = 'TERM' | 'KILL'
const legOf = process.argv.find(a => a === '--leg=TERM' || a === '--leg=KILL') as `--leg=${Leg}` | undefined
const legs: Leg[] = legOf === undefined ? ['TERM', 'KILL'] : [legOf.slice('--leg='.length) as Leg]

try {
  for (const leg of legs) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), `launcher-${leg.toLowerCase()}-`)))
    seedFirstRun(home, [home])
    const api = await startFixtureApi([{ kind: 'hang', deltas: ['The turn is open.'] }])
    const cwd = join(home, 'project')
    mkdirSync(cwd)
    const child = spawn(join(install, 'mercury'), ['run', '--format', 'rows', 'reply with PONG'], {
      cwd,
      env: {
        HOME: home,
        PATH: process.env.PATH,
        TMPDIR: tmpdir(),
        MERCURY_CONFIG_DIR: home,
        MERCURY_HOME: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_NO_BANNER: '1',
        ANTHROPIC_API_KEY: 'fixture-key',
        ANTHROPIC_BASE_URL: api.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { out += String(d) })
    await api.messageRequestStarted(1)
    const launcherPid = child.pid!
    const started = Date.now()
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
      child.on('exit', (code, signal) => resolve({ code, signal })))
    const descendantsOf = (rootPid: number): number[] => {
      const snapshot = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout
        .split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split(/\s+/))
        .map(parts => ({ pid: Number(parts[0]), ppid: Number(parts[1]) }))
      const childrenOf = new Map<number, number[]>()
      for (const row of snapshot) {
        if (!Number.isFinite(row.pid) || !Number.isFinite(row.ppid)) continue
        const list = childrenOf.get(row.ppid) ?? []
        list.push(row.pid)
        childrenOf.set(row.ppid, list)
      }
      const found: number[] = []
      let frontier = [rootPid]
      for (let depth = 0; depth < 5 && frontier.length > 0; depth++) {
        const next: number[] = []
        for (const pid of frontier) for (const kid of childrenOf.get(pid) ?? []) {
          if (kid === process.pid || found.includes(kid)) continue
          found.push(kid)
          next.push(kid)
        }
        frontier = next
      }
      return found
    }
    const runPids = descendantsOf(launcherPid)
    process.kill(launcherPid, leg === 'TERM' ? 'SIGTERM' : 'SIGKILL')
    const wall = new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 60_000).unref?.())
    const outcome = await Promise.race([exited.then(r => ({ ...r, kind: 'exit' as const })), wall.then(w => ({ kind: w, code: null, signal: null }))])
    const elapsed = Date.now() - started
    await new Promise(r => setTimeout(r, 1500))
    const aliveAfter = (() => {
      const snapshot = spawnSync('ps', ['-axo', 'pid='], { encoding: 'utf8' }).stdout
        .split('\n').map(l => l.trim()).filter(Boolean).map(l => Number(l))
      return runPids.filter(pid => snapshot.includes(pid))
    })()
    const rows = out.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(r => r !== null) as Array<Record<string, unknown>>
    const outcomeRows = rows.filter(r => r.type === 'outcome')
    const lastOutcome = outcomeRows.at(-1)
    if (leg === 'TERM') {
      check('TERM: the launcher run exits 143 (the runtime ended the run, wrote its row, exited with the signal code)', outcome.kind === 'exit' && outcome.code === 143, JSON.stringify(outcome))
      check('TERM: the exit is prompt (the turn is ended, not waited out)', outcome.kind === 'exit' && elapsed < 30_000, `${elapsed}ms`)
      check('TERM: the final row says the run was interrupted, not completed', typeof lastOutcome?.status === 'string' && lastOutcome.status === 'interrupted', JSON.stringify(lastOutcome))
      check(`TERM: no orphaned run survives the signal (${runPids.length} pid(s) at signal time)`, aliveAfter.length === 0, `still alive: ${aliveAfter.join(' ')}`)
    } else {
      check('KILL: the launcher run dies (no exit code, killed)', outcome.kind === 'exit' && outcome.signal === 'SIGKILL', JSON.stringify(outcome))
      check(`KILL: no orphaned run finishes the work behind the caller (${runPids.length} pid(s) at signal time)`, aliveAfter.length === 0, `still alive: ${aliveAfter.join(' ')}`)
    }
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    for (const pid of runPids) { try { process.kill(pid, 'SIGKILL') } catch { } }
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
} finally {
  spawnSync('pkill', ['-9', '-f', work])
  rmSync(work, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
