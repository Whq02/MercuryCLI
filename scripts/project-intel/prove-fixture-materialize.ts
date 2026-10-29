#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { materializeFixture } from './fixtures/materialize.js'

const REPO = resolve(import.meta.dir, '..', '..')
const SYS_PY = '/usr/bin/python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const cleanup: string[] = []

section('(1) fixtures materialize outside the repo, git-clean at baseline')
const tsDir = materializeFixture('ts')
cleanup.push(tsDir)
check('ts fixture lands outside the repo', !tsDir.startsWith(REPO), tsDir)
const tsStatus = execFileSync('git', ['-C', tsDir, 'status', '--porcelain']).toString().trim()
check('ts fixture is git-clean at baseline', tsStatus === '', tsStatus)
check(
  'ts fixture carries exactly one commit (the baseline)',
  execFileSync('git', ['-C', tsDir, 'rev-list', '--count', 'HEAD']).toString().trim() === '1',
)

const pyDir = materializeFixture('py')
cleanup.push(pyDir)
check('py fixture lands outside the repo', !pyDir.startsWith(REPO), pyDir)
const pyStatus = execFileSync('git', ['-C', pyDir, 'status', '--porcelain']).toString().trim()
check('py fixture is git-clean at baseline', pyStatus === '', pyStatus)

section('(2) ts fixture: tsc clean under the repo checker')
const tsc = join(REPO, 'node_modules', 'typescript', 'bin', 'tsc')
check('repo tsc exists', existsSync(tsc))
if (existsSync(tsc)) {
  let clean = true
  let out = ''
  try {
    execFileSync(
      'node',
      [tsc, '-p', tsDir, '--noEmit', '--typeRoots', join(REPO, 'node_modules', '@types'), '--types', 'node'],
      { stdio: 'pipe' },
    )
  } catch (err) {
    clean = false
    out = (err as { stdout?: Buffer }).stdout?.toString().slice(0, 400) ?? String(err)
  }
  check('ts fixture typechecks', clean, out)
}

section('(3) py fixture: unittest discovery green')
if (!existsSync(SYS_PY)) {
  console.log(`  [SKIP — LOUD] ${SYS_PY} absent on this machine`)
} else {
  let green = true
  let detail = ''
  try {
    execFileSync(SYS_PY, ['-m', 'unittest', 'discover', '-s', 'tests'], {
      cwd: pyDir,
      stdio: 'pipe',
    })
  } catch (err) {
    green = false
    detail = (err as { stderr?: Buffer }).stderr?.toString().slice(-300) ?? String(err)
  }
  check('py unittest suite green', green, detail)
}

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ FIXTURE MATERIALIZATION PROOF PASSES')
process.exit(0)
