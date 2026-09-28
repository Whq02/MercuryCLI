#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPTS = join(ROOT, 'scripts')
const HARNESS = join(SCRIPTS, 'lib', 'settingsPopupHarness.ts')
const PROVER = join(SCRIPTS, 'ui', 'prove-composer-draft-survives-dispatch.ts')
const HOME_STEM = 'composer-draft-dispatch'
const MARK = 'planted-rm-fault'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)
const tidy = (path: string): void => {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch (error) {
    console.log(`  (left behind: ${path} — ${String(error)})`)
  }
}

section('§0 the harness owns one guarded release beside its scratch-home pin')
const harness = readFileSync(HARNESS, 'utf8')
check('scripts/lib/settingsPopupHarness.ts exports releaseScratchHome beside pinScratchHome', harness.includes('export function pinScratchHome(') && harness.includes('export async function releaseScratchHome(home: string): Promise<void>'))
check('the release leaves the tree before removing it (a process inside the home is one holder)', harness.includes('process.chdir(tmpdir())'))
check('the release tries rmSync twice a tick apart, then the system rm, and prints one note — the verdict stands', /for \(const attempt of \[1, 2\]\) \{\s*try \{\s*rmSync\(home, \{ recursive: true, force: true \}\)\s*return\s*\} catch/.test(harness) && harness.includes("spawnSync('rm', ['-rf', home]") && harness.includes('; the verdict stands`)'))

section('§1 every prover that pins a scratch home through the harness releases it through the harness, never a bare rmSync of the pinned home')
const provers: string[] = []
const walk = (dir: string): void => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'vendor') continue
    if (statSync(path).isDirectory()) walk(path)
    else if (name.startsWith('prove-') && name.endsWith('.ts')) provers.push(path)
  }
}
walk(SCRIPTS)
const pinned = provers
  .map(path => ({ path, text: readFileSync(path, 'utf8') }))
  .filter(({ text }) => /from '\.\.\/lib\/settingsPopupHarness\.ts'/.test(text) && text.includes('pinScratchHome('))
const offenders: string[] = []
const released: string[] = []
for (const { path, text } of pinned) {
  const bound = text.match(/const (\w+) = pinScratchHome\(/)?.[1]
  const rel = relative(ROOT, path)
  if (bound === undefined) {
    offenders.push(`${rel} (no const bound to pinScratchHome)`)
    continue
  }
  const bare = new RegExp(`\\brmSync\\(${bound}\\b`).test(text)
  const guarded = text.includes(`releaseScratchHome(${bound})`)
  if (bare || !guarded) offenders.push(`${rel} (${bare ? `rmSync(${bound}…)` : ''}${bare && !guarded ? ', ' : ''}${guarded ? '' : `no releaseScratchHome(${bound})`})`)
  else released.push(rel)
}
check(`${pinned.length} provers pin a scratch home through the harness (the family the shape can bite)`, pinned.length >= 20, String(pinned.length))
check(`every one of them releases the pinned home through releaseScratchHome — ${released.length} do; none removes it with a bare rmSync`, offenders.length === 0 && released.length === pinned.length, offenders.join('; '))

section('§2 the composer-draft prover under a planted rmSync fault (the hosted shape: EFAULT from Bun\'s recursive rm after every check passed)')
const scratch = mkdtempSync(join(tmpdir(), 'scratch-home-release-'))
const preload = join(scratch, 'plant-rm-fault.ts')
writeFileSync(
  preload,
  [
    "import { mock } from 'bun:test'",
    "import * as fs from 'node:fs'",
    'const faulty = (path: unknown, options?: unknown): void => {',
    `  if (String(path).includes('${HOME_STEM}')) throw Object.assign(new Error(\`EFAULT: bad address in system call argument, rm '\${String(path)}' (${MARK})\`), { code: 'EFAULT', errno: -14, syscall: 'rm', path: String(path) })`,
    '  return fs.rmSync(path as string, options as never)',
    '}',
    "mock.module('node:fs', () => ({ ...fs, default: { ...fs.default, rmSync: faulty }, rmSync: faulty }))",
    '',
  ].join('\n'),
)
const bunfig = join(scratch, 'bunfig.toml')
writeFileSync(bunfig, `preload = [${JSON.stringify(join(SCRIPTS, 'lib', 'proofHomePreload.ts'))}, ${JSON.stringify(preload)}]\n`)
console.log(`  running prove-composer-draft-survives-dispatch with rmSync faulted for every path under a ${HOME_STEM}-* home (the plant rides a scratch bunfig behind the repo preload)`)
const started = Date.now()
const run = spawnSync(process.execPath, ['run', `--config=${bunfig}`, PROVER], { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, timeout: 300_000, maxBuffer: 1 << 26 })
const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
const lines = out.split('\n')
const passes = lines.filter(line => line.includes('[PASS]')).length
const fails = lines.filter(line => line.includes('[FAIL]')).length
console.log(`  the prover ran ${Math.round((Date.now() - started) / 1000)} s · rc=${String(run.status)} · signal=${String(run.signal)} · ${passes} [PASS] · ${fails} [FAIL]`)
const homes = [...new Set([...out.matchAll(new RegExp(`(/\\S*?${HOME_STEM}-[A-Za-z0-9]+)`, 'g'))].map(match => match[1]!))]
const noteLine = lines.find(line => line.includes('scratch home ') && line.includes(MARK)) ?? ''
const note = noteLine.slice(Math.max(0, noteLine.indexOf('scratch home ')))
check(`the planted rmSync fault fired on the scratch home (${MARK} appears in the output)`, out.includes(MARK), lines.slice(-12).join(' | '))
check('every inner check passed and none failed (the verdict the cleanup must keep is ALL PASS)', passes >= 25 && fails === 0, `${passes} [PASS], ${fails} [FAIL]`)
check('the prover exits 0 when every check passed and only the scratch-home removal failed', run.status === 0, `rc=${String(run.status)} — the cleanup fault turned a green proof red: ${lines.filter(line => line.includes('EFAULT')).join(' | ').slice(0, 300)}`)
check('the ALL PASS verdict is printed after the failed removal', out.includes('prove-composer-draft-survives-dispatch: ALL PASS'), lines.slice(-6).join(' | '))
check('the fault was caught, not crashed (no uncaught EFAULT trace with its syscall frame)', !out.includes('syscall: "rm"'), lines.filter(line => line.includes('syscall')).join(' | '))
check('one line names the scratch home, the error, and says the verdict stands', note !== '' && homes.some(home => note.includes(home)) && note.includes('EFAULT') && note.endsWith('; the verdict stands'), note || lines.filter(line => line.startsWith('scratch home')).join(' | ') || 'no scratch-home line')
check('the fallback road swept the home once rmSync had failed twice (rm -rf)', note.includes('rmSync failed twice') && note.includes('removed by rm -rf') && homes.length > 0 && homes.every(home => !existsSync(home)), `${note} · homes: ${homes.join(', ')}`)

if (failures > 0) {
  console.log("\n  the prover's last lines:")
  for (const line of lines.filter(line => line.trim() !== '').slice(-25)) console.log(`  │ ${line.slice(0, 200)}`)
}
for (const home of homes) if (existsSync(home)) tidy(home)
tidy(scratch)
console.log(failures === 0 ? '\nprove-scratch-home-release: ALL PASS' : `\nprove-scratch-home-release: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
