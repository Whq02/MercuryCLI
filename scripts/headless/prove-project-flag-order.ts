#!/usr/bin/env bun
// gate-watch: src/boot/main.tsx src/boot/entrypoints/cli.tsx src/boot/entrypoints/projectRoot.ts src/platform/processes/gracefulShutdown.ts src/daemon/runner/refusalEnvelope.ts
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

const home = mkdtempSync(join(tmpdir(), 'project-order-home-'))
const cwd = mkdtempSync(join(tmpdir(), 'project-order-cwd-'))
const project = mkdtempSync(join(tmpdir(), 'project-order-target-'))
mkdirSync(join(project, '.git'), { recursive: true })
const configDir = join(home, '.mercury')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, '.config.json'), JSON.stringify({
  theme: 'dark',
  hasCompletedOnboarding: true,
  projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }, [project]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
}))
const crashDir = join(configDir, 'crashes')
const nodeDir = dirname(process.execPath)
const env = {
  HOME: home,
  PATH: `/usr/bin:/bin:${nodeDir}:${process.env.PATH ?? ''}`,
  TERM: 'xterm-256color',
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  BROWSER: '/usr/bin/true',
}
type Run = { code: number | null; stdout: string; stderr: string }
const run = (args: string[]): Promise<Run> =>
  new Promise(resolve => {
    const c = spawn('node', [DIST, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', d => (stdout += d))
    c.stderr.on('data', d => (stderr += d))
    c.stdin.end()
    const k = setTimeout(() => c.kill('SIGKILL'), 60_000)
    c.on('exit', code => {
      clearTimeout(k)
      resolve({ code, stdout, stderr })
    })
  })
const crashFiles = (): string[] => (existsSync(crashDir) ? readdirSync(crashDir) : [])
const outcomeOf = (stdout: string): { status?: string; error?: { message?: string; class?: string } } | undefined =>
  stdout.split('\n').map(l => { try { return JSON.parse(l) as { type?: string; status?: string; error?: { message?: string; class?: string } } } catch { return null } }).find(r => r?.type === 'outcome') ?? undefined
const REMEDY = `--project ${project} run`
const CARD = 'MERCURY COULD NOT START'
const OLD_WORDS = 'must appear before all other arguments'

console.log('§1 --project after the run verb, on the rows road: a usage refusal (exit 2) whose line names the remedy with the flag before the command word; no crash report (RED on the base: exit 1, class load, the old sentence)')
for (const args of [
  ['run', '--project', project, '--format', 'rows', '--', 'hi'],
  ['run', '--format', 'rows', '--project', project, '--', 'hi'],
  ['run', '--format', 'rows', `--project=${project}`, '--', 'hi'],
]) {
  const r = await run(args)
  const outcome = outcomeOf(r.stdout)
  const label = args.join(' ').replace(project, '<dir>')
  check(`${label}: exit 2`, r.code === 2, `a late --project must be refused as a usage error with exit 2, not a crash with exit 1; check the --project option in src/boot/main/rootOptions.ts · ${r.code} · ${(r.stdout + r.stderr).trim().slice(0, 200)}`)
  check(`${label}: the refused outcome row carries the remedy`, outcome?.status === 'refused' && (outcome.error?.message ?? '').includes('--project goes before the command word') && (outcome.error?.message ?? '').includes(REMEDY), `the refused outcome row must carry the remedy text thrown by the --project option in src/boot/main/rootOptions.ts · ${outcome?.error?.message ?? r.stdout.slice(0, 200)}`)
  check(`${label}: the old sentence is gone`, !(r.stdout + r.stderr).includes(OLD_WORDS), 'the retired sentence still prints; replace it with the --project remedy in src/boot/main/rootOptions.ts')
  check(`${label}: no crash card and no crash report`, !(r.stdout + r.stderr).includes(CARD) && crashFiles().length === 0, `a late --project must be refused before boot, with no crash card and no crash report; check the --project option in src/boot/main/rootOptions.ts · ${crashFiles().join(',')} ${r.stderr.slice(0, 200)}`)
}

console.log('§2 --project after the run verb, on the plain road (the shape that wrote a boot crash report on the base): one stderr line with the remedy, exit 2, no card, no report, no stack')
for (const args of [
  ['run', '--project', project, 'hi'],
  ['run', '--format', 'text', '--project', project, '--', 'hi'],
  ['--model', 'some-model', '--project', project],
]) {
  const r = await run(args)
  const label = args.join(' ').replace(project, '<dir>')
  const lines = r.stderr.split('\n').filter(l => l.trim().length > 0)
  check(`${label}: exit 2 (a usage error, never 1)`, r.code === 2, `a late --project must exit 2, never 1; check the --project option in src/boot/main/rootOptions.ts · ${r.code} · ${(r.stdout + r.stderr).trim().slice(0, 200)}`)
  check(`${label}: one line on stderr, naming the remedy`, lines.length === 1 && lines[0]!.includes('--project goes before the command word') && lines[0]!.includes(REMEDY), `stderr must be exactly one line holding the remedy text from the --project option in src/boot/main/rootOptions.ts · ${r.stderr.slice(0, 300)}`)
  check(`${label}: no crash card, no stack frame, no crash report`, !r.stderr.includes(CARD) && !/^\s+at /m.test(r.stderr) && crashFiles().length === 0, `a late --project must be refused with no crash card, no stack frame and no crash report; check the --project option in src/boot/main/rootOptions.ts · ${crashFiles().join(',')} ${r.stderr.slice(0, 300)}`)
  check(`${label}: the old sentence is gone`, !(r.stdout + r.stderr).includes(OLD_WORDS), 'the retired sentence still prints; replace it with the --project remedy in src/boot/main/rootOptions.ts')
}

console.log('§3 a folder with a space is quoted in the remedy')
{
  const spaced = mkdtempSync(join(tmpdir(), 'project order spaced-'))
  const r = await run(['run', '--project', spaced, 'hi'])
  check('the remedy quotes the folder', r.code === 2 && r.stderr.includes(`--project ${JSON.stringify(spaced)} run`), `a folder with whitespace must be JSON-quoted in the remedy; check the --project option in src/boot/main/rootOptions.ts · ${r.stderr.slice(0, 300)}`)
  rmSync(spaced, { recursive: true, force: true })
}

console.log('§4 the right order still works, and the help text says the law in plain words')
{
  const r = await run(['--project', project, '--help'])
  check('mercury --project <dir> --help exits 0 (the folder flag first is accepted)', r.code === 0 && !r.stderr.includes('--project goes before'), `the folder flag before the command word must be accepted; check the --project option in src/boot/main/rootOptions.ts · ${r.code} · ${r.stderr.slice(0, 200)}`)
  const helpLine = r.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('--project'))
  const joined = r.stdout.replace(/\s+/g, ' ')
  check('the --project help line says to pass it before the command word, with the example', helpLine.length === 1 && joined.includes('Pass it before the command word') && joined.includes('mercury --project <dir> run'), `the help text of the --project option in src/boot/main/rootOptions.ts must say to pass it before the command word, with the mercury --project <dir> run example · ${helpLine.join(' | ') || r.stdout.slice(0, 200)}`)
  check('the old sentence is not in the help', !joined.includes(OLD_WORDS), 'the retired sentence is in the help; reword the --project help in src/boot/main/rootOptions.ts')
  check('no crash report was written by any road above', crashFiles().length === 0, `a crash report was written by one of the runs above; the run printed before this check names the road, and the --project option in src/boot/main/rootOptions.ts is where the late flag is refused · ${crashFiles().join(',')}`)
}

for (const dir of [home, cwd, project]) rmSync(dir, { recursive: true, force: true })
console.log(`\n${checks - failures}/${checks} checks passed`)
console.log(failures === 0 ? 'project-flag-order: ALL LAWS HOLD' : `project-flag-order: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
