#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

console.log('============================================================')
console.log(' a recursive directory watcher whose root is deleted')
console.log('============================================================')

const hook = readFileSync(resolve(import.meta.dir, '../../src/hooks/useSkillsChange.ts'), 'utf8')
check('the skills hook arms its recursive watcher through watchDirectory', /watchDirectory\(resolveWatchRoot\(dir\)/.test(hook))

const { watchDirectory } = await import('../../src/utils/watchRoot.ts')
check('watchRoot exports watchDirectory', typeof watchDirectory === 'function')

if (process.platform !== 'win32') {
  if (typeof watchDirectory === 'function') {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'watch-root-live-')))
    const project = join(base, 'proj')
    const skills = join(project, '.mercury', 'skills')
    mkdirSync(skills, { recursive: true })
    let changes = 0
    let gone = 0
    const watcher = watchDirectory(
      skills,
      { recursive: true },
      () => {
        changes++
      },
      () => {
        gone++
      },
    )
    watcher.on('error', () => {})
    await sleep(400)
    writeFileSync(join(skills, 'SKILL.md'), 'live')
    const until = Date.now() + 8_000
    while (changes === 0 && Date.now() < until) await sleep(100)
    check('an event on a live root reaches onChange', changes > 0, `${changes} change callback(s)`)
    rmSync(project, { recursive: true, force: true })
    await sleep(700)
    check('onGone never fires on POSIX, even once the root is deleted', gone === 0, `onGone ran ${gone} time(s)`)
    watcher.close()
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 })
    } catch {
    }
  }
} else if (typeof watchDirectory === 'function') {
  const base = mkdtempSync(join(tmpdir(), 'watch-root-gone-'))
  const project = join(base, 'proj')
  const skills = join(project, '.mercury', 'skills')
  mkdirSync(skills, { recursive: true })
  let changes = 0
  let gone = 0
  let changesAtGone = -1
  const watcher = watchDirectory(
    skills,
    { recursive: true },
    () => {
      changes++
    },
    () => {
      gone++
      changesAtGone = changes
    },
  )
  watcher.on('error', () => {})
  await sleep(200)
  rmSync(project, { recursive: true, force: true })
  await sleep(700)
  check('the watcher reports its root gone exactly once', gone === 1, `onGone ran ${gone} time(s)`)
  check('no change callbacks arrive once the root is gone', changesAtGone >= 0 && changes === changesAtGone, `changes ${changes}, at gone ${changesAtGone}`)
  watcher.close()
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3 })
  } catch {
  }
}

console.log(failures === 0 ? '\nALL WATCH-ROOT-GONE CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
