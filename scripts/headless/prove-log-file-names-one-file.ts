#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const home = mkdtempSync(join(tmpdir(), 'log-file-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'log-file-cwd-'))
const configDir = join(home, '.mercury')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, '.config.json'), JSON.stringify({
  theme: 'dark',
  hasCompletedOnboarding: true,
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}))
const nodeDir = dirname(process.execPath)
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
  TERM: 'xterm-256color',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
}
const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (out += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 90_000)
    c.on('exit', code => {
      clearTimeout(k)
      resolve({ code, out })
    })
  })
const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

console.log('§1 run --debug --log-file <dir>/x.log writes x.log and nothing else beside it')
{
  const dir = join(home, 'logs')
  mkdirSync(dir)
  const named = join(dir, 'x.log')
  const r = await run(['run', '--debug', '--log-file', named, '--resume', 'notauuid', 'hi'])
  check('the run reached its door (the bad resume target refuses, exit 2)', r.code === 2, `${r.code} · ${r.out.trim().slice(0, 120)}`)
  check('the named file holds debug lines', existsSync(named) && readFileSync(named, 'utf8').length > 0, existsSync(named) ? `${readFileSync(named, 'utf8').length} bytes` : 'absent')
  const beside = readdirSync(dir)
  check('x.log is the only entry in its directory — no latest link, no rotated sibling', beside.length === 1 && beside[0] === 'x.log', beside.join(', '))
  check('the config home grew no debug/ directory for this run', !existsSync(join(configDir, 'debug')), existsSync(join(configDir, 'debug')) ? readdirSync(join(configDir, 'debug')).join(', ') : '')
}

console.log('§2 the default road (--debug without --log-file) still keeps debug/<session>.txt and its latest link under the config home')
{
  const r = await run(['run', '--debug', '--resume', 'notauuid', 'hi'])
  check('the run reached its door (exit 2)', r.code === 2, `${r.code} · ${r.out.trim().slice(0, 120)}`)
  const debugDir = join(configDir, 'debug')
  const entries = existsSync(debugDir) ? readdirSync(debugDir) : []
  check('one per-session .txt log under debug/', entries.filter(e => e.endsWith('.txt')).length === 1, entries.join(', '))
  check('…and the latest link beside it, pointing at a log', isLink(join(debugDir, 'latest')), entries.join(', '))
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-log-file-names-one-file: ALL LAWS HOLD' : `\nprove-log-file-names-one-file: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
