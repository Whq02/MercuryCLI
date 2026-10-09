#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map(line => line.trim())
const trackedInstructionFiles = tracked.filter(path => /(^|\/)MERCURY(\.local)?\.md$/.test(path))
const trackedProjectHomeFiles = tracked.filter(path => /(^|\/)\.mercury\//.test(path))

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

check('the repository tracks no MERCURY.md and no MERCURY.local.md anywhere', trackedInstructionFiles.length === 0, trackedInstructionFiles.join(', '))
check('the repository tracks nothing under a .mercury/ project home', trackedProjectHomeFiles.length === 0, trackedProjectHomeFiles.join(', '))
check('.gitignore keeps the root MERCURY.local.md out of every commit', ignore.includes('/MERCURY.local.md'))
check('.gitignore keeps the .mercury/ project home out of every commit', ignore.includes('.mercury/'))
check('AGENTS.md stands as the public tree\'s instruction file', tracked.includes('AGENTS.md'))

console.log(failures === 0 ? 'instruction file privacy: ALL PASS' : `instruction file privacy: FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
