#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PROVER = join(ROOT, 'scripts', 'updater', 'prove-update-notice-stay.ts')
const HOME_STEM = 'update-notice-stay'
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

const scratch = mkdtempSync(join(tmpdir(), 'cleanup-keeps-verdict-'))
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
writeFileSync(bunfig, `preload = [${JSON.stringify(join(ROOT, 'scripts', 'lib', 'proofHomePreload.ts'))}, ${JSON.stringify(preload)}]\n`)

console.log('============================================================')
console.log(' a green proof never turns red on its own scratch-home cleanup')
console.log('============================================================')
console.log(`  running prove-update-notice-stay with rmSync faulted for every path under a ${HOME_STEM}-* home (the plant rides a scratch bunfig behind the repo preload)`)

const started = Date.now()
const run = spawnSync(process.execPath, ['run', `--config=${bunfig}`, PROVER], { cwd: ROOT, encoding: 'utf8', env: { ...process.env }, timeout: 300_000, maxBuffer: 1 << 26 })
const out = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
const lines = out.split('\n')
const passes = lines.filter(line => line.includes('[PASS]')).length
const fails = lines.filter(line => line.includes('[FAIL]')).length
console.log(`  the prover ran ${Math.round((Date.now() - started) / 1000)} s · rc=${String(run.status)} · signal=${String(run.signal)} · ${passes} [PASS] · ${fails} [FAIL]`)
const homes = [...new Set([...out.matchAll(new RegExp(`(/\\S*?${HOME_STEM}-[A-Za-z0-9]+)`, 'g'))].map(match => match[1]!))]
const note = lines.find(line => line.startsWith('scratch home ') && line.includes(MARK)) ?? ''

section('§1 the fault was planted and the proof under test was green on its own terms')
check(`the planted rmSync fault fired on the scratch home (${MARK} appears in the output)`, out.includes(MARK), lines.slice(-12).join(' | '))
check('every inner check passed and none failed (the verdict the cleanup must keep is ALL PASS)', passes >= 15 && fails === 0, `${passes} [PASS], ${fails} [FAIL]`)

section('§2 the verdict stands: the failed removal is a note, never a red')
check('the prover exits 0 when every check passed and only the scratch-home removal failed', run.status === 0, `rc=${String(run.status)} — the cleanup fault turned a green proof red: ${lines.filter(line => line.includes('EFAULT')).join(' | ').slice(0, 300)}`)
check('the ALL PASS verdict is printed after the failed removal', out.includes('ALL PASS'), lines.slice(-6).join(' | '))
check('the fault was caught, not crashed (no uncaught EFAULT trace with its syscall frame)', !out.includes('syscall: "rm"'), lines.filter(line => line.includes('syscall')).join(' | '))
check('one line names the scratch home, the error, and says the verdict stands', note !== '' && homes.some(home => note.includes(home)) && note.includes('EFAULT') && note.endsWith('; the verdict stands'), note || lines.filter(line => line.startsWith('scratch home')).join(' | ') || 'no scratch-home line')
check('the fallback road swept the home once rmSync had failed twice (rm -rf)', note.includes('rmSync failed twice') && note.includes('removed by rm -rf') && homes.length > 0 && homes.every(home => !existsSync(home)), `${note} · homes: ${homes.join(', ')}`)

if (failures > 0) {
  console.log('\n  the prover\'s last lines:')
  for (const line of lines.filter(line => line.trim() !== '').slice(-25)) console.log(`  │ ${line.slice(0, 200)}`)
}
for (const home of homes) if (existsSync(home)) tidy(home)
tidy(scratch)
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
