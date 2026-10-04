#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const SCRATCH = mkdtempSync(join(tmpdir(), 'boot-kind-'))
type Row = { milestone: string; boot?: string; pid: number }
const world = (tag: string): { configDir: string; cwd: string; env: Record<string, string> } => {
  const home = join(SCRATCH, tag)
  const configDir = join(home, '.mercury')
  const cwd = join(home, 'cwd')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(configDir, '.config.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  return { configDir, cwd, env: { HOME: home, PATH: `/usr/bin:/bin:${process.env.PATH ?? ''}`, TERM: 'xterm-256color', MERCURY_CONFIG_DIR: configDir, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon') } }
}
const rows = (configDir: string): Row[] => {
  try {
    return (JSON.parse(readFileSync(join(configDir, 'launch-milestones.json'), 'utf8')) as { rows: Row[] }).rows
  } catch {
    return []
  }
}

console.log('§1 a redirected start (stdout is a file) is recorded for what it is: a headless boot, never an interactive one')
for (const args of [['--chat'], ['usage']]) {
  const w = world(args.join('-').replace(/^-+/, 'bare-'))
  const r = spawnSync('node', [DIST, ...args], { cwd: w.cwd, env: w.env, encoding: 'utf8', input: '', timeout: 90_000 })
  const entry = rows(w.configDir).find(row => row.milestone === 'runtime-entry')
  check(`mercury ${args.join(' ')} > file: the run took the headless door (exit 1, no screen)`, r.status === 1, `${r.status} · ${(r.stdout + r.stderr).trim().slice(0, 120)}`)
  check(`…and its runtime-entry row says boot: headless`, entry !== undefined && entry.boot === 'headless', JSON.stringify(entry))
}

console.log('§2 control: run stamps headless too, and a redirected run leaves nothing /health reads as an interactive spine')
{
  const w = world('run')
  spawnSync('node', [DIST, 'run', '--resume', 'notauuid', 'hi'], { cwd: w.cwd, env: w.env, encoding: 'utf8', timeout: 90_000 })
  const entry = rows(w.configDir).find(row => row.milestone === 'runtime-entry')
  check('mercury run: runtime-entry says boot: headless', entry?.boot === 'headless', JSON.stringify(entry))
  const h = spawnSync('node', [DIST, 'health', '--only', 'launch-spine', '--json'], { cwd: w.cwd, env: w.env, encoding: 'utf8', timeout: 180_000 })
  let status = ''
  try {
    const cert = JSON.parse(h.stdout) as { sections: Array<{ checks: Array<{ id: string; status: string; evidence?: string }> }> }
    status = cert.sections.flatMap(s => s.checks).find(c => c.id === 'launch-spine')?.status ?? ''
  } catch {
    status = `unparsed: ${(h.stdout + h.stderr).slice(0, 120)}`
  }
  check('the Boot milestones row does not warn over headless rows', status !== 'warn' && status !== 'fail', status)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-redirected-run-boot-kind: ALL LAWS HOLD' : `\nprove-redirected-run-boot-kind: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
