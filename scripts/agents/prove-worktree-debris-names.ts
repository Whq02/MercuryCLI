#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-debris-names-')))
const home = join(scratch, 'worktrees')
mkdirSync(home)
const waiting: Promise<void>[] = []
let script = ''
const spawn = childProcess.spawn
mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: (...args: Parameters<typeof spawn>): ReturnType<typeof spawn> => {
    const child = spawn(...args)
    if (args[1]?.[0] === '-e') {
      script = args[1][1] as string
      waiting.push(new Promise(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()) }))
    }
    return child
  },
}))
const { discardSetAside, sweepSetAside } = await import('../../src/utils/worktreeClone.ts')
let failures = 0
const check = (label: string, ok: boolean): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) failures++
}
const make = (name: string, old = true): string => {
  const path = join(home, name)
  mkdirSync(path)
  writeFileSync(join(path, 'precious'), 'keep me')
  if (old) utimesSync(path, new Date(0), new Date(0))
  return path
}
const whole = (path: string): boolean => {
  try { return readFileSync(join(path, 'precious'), 'utf8') === 'keep me' } catch { return false }
}
try {
  const personal = ['.cloning-personal-notes', '.removing-old', '.cloning-personal-12-short', '.removing-user-NaN-abcdefgh'].map(name => make(name))
  const stamp = Date.now().toString(36)
  const stage = make(`.cloning-agent-a123abcd-123-${stamp}0`)
  const aside = make(`.removing-agent-a123abcd-123-${stamp}`)
  const fresh = make(`.cloning-agent-a123abce-123-${stamp}1`, false)
  const probe = join(home, '.cloning-probe-123-0')
  writeFileSync(probe, 'probe')
  utimesSync(probe, new Date(0), new Date(0))
  check('only old generated names enter the sweep', sweepSetAside(home) === 3)
  await Promise.all(waiting)
  for (const path of personal) check(`a personal folder survives the sweep: ${path.slice(home.length + 1)}`, whole(path))
  check('a generated staging leftover is swept', !existsSync(stage))
  check('a generated set-aside leftover is swept', !existsSync(aside))
  check('a generated probe leftover is swept', !existsSync(probe))
  check('a generated leftover inside the grace remains', whole(fresh))
  for (const path of personal) discardSetAside(path)
  await Promise.all(waiting)
  check('direct discard also leaves every non-generated name alone', personal.every(whole))
  check('the detached script is captured from a real discard', script !== '')
  if (script !== '') {
    const direct = make('.removing-direct-personal')
    const child = childProcess.spawnSync(process.execPath, ['-e', script, direct], { encoding: 'utf8', env: process.env, timeout: 30_000 })
    check('the detached script itself refuses a non-generated name', child.status === 0 && whole(direct))
  }
  if (process.platform !== 'win32') {
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious'), 'keep me')
    const link = join(home, `.removing-link-123-${stamp}`)
    symlinkSync(outside, link)
    discardSetAside(link)
    await Promise.all(waiting)
    check('discard unlinks a generated root link without touching its referent', !existsSync(link) && whole(outside))
  }
} finally {
  await Promise.all(waiting)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
