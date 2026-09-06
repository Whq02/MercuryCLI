#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const home = mkdtempSync(join(tmpdir(), 'flag-contra-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'flag-contra-cwd-'))
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
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
}
const run = (args: string[]): Promise<{ code: number | null; out: string }> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', d => (out += d))
    c.stderr.on('data', d => (out += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 60_000)
    c.on('exit', code => {
      clearTimeout(k)
      resolve({ code, out })
    })
  })

console.log('§1 --continue beside --resume refuses (nothing silently discarded)')
{
  const r = await run(['--continue', '--resume', 'some-title', '-p', 'hi'])
  check('exit 2 (a usage error), both flags named', r.code === 2 && /--continue and --resume name two different sessions/.test(r.out), `${r.code} · ${r.out.trim().slice(0, 120)}`)
}

console.log('§2 --extension with a missing path refuses, naming it')
{
  const missing = join(cwd, 'no-such-extension-dir')
  const r = await run(['--extension', missing, '-p', 'hi'])
  check('exit 1, the path named', r.code === 1 && r.out.includes('--extension path') && r.out.includes(missing), `${r.code} · ${r.out.trim().slice(0, 120)}`)
}

rmSync(home, { recursive: true, force: true })
rmSync(cwd, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-flag-contradictions: ALL LAWS HOLD' : `\nprove-flag-contradictions: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
