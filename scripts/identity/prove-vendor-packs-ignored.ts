#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const rules = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map(line => line.trim())
const names = rules.flatMap(line => /^(node_modules|vendor\/[^/*]+)\/?$/.exec(line)?.[1] ?? [])

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'packs-ignored-'))
const repo = join(scratch, 'checkout')
const elsewhere = join(scratch, 'elsewhere')
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', ...args], { encoding: 'utf8' }).trim()
const ignored = (path: string): boolean => spawnSync('git', ['-C', repo, 'check-ignore', '-q', '--', path]).status === 0
const stamp = (): string => {
  const index = join(scratch, `index-${Math.random().toString(36).slice(2)}`)
  const env = { ...process.env, GIT_INDEX_FILE: index }
  execFileSync('git', ['-C', repo, 'read-tree', 'HEAD'], { env })
  execFileSync('git', ['-C', repo, 'add', '--all'], { env })
  return execFileSync('git', ['-C', repo, 'write-tree'], { env, encoding: 'utf8' }).trim()
}
try {
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  copyFileSync(join(root, '.gitignore'), join(repo, '.gitignore'))
  git('add', '.gitignore')
  git('commit', '-q', '-m', 'the ignore rules')
  const head = git('rev-parse', 'HEAD^{tree}')
  check('the ignore rules name node_modules and the vendored packs', names.includes('node_modules') && names.filter(name => name.startsWith('vendor/')).length >= 15, names.join(' '))

  for (const name of names) {
    mkdirSync(join(repo, name), { recursive: true })
    writeFileSync(join(repo, name, 'payload'), name)
  }
  const openFolders = names.filter(name => !ignored(`${name}/payload`))
  check(`each of the ${names.length} names is ignored where it stands as a folder`, openFolders.length === 0, openFolders.join(' '))
  check('a checkout whose packs are folders has nothing to add', git('status', '--porcelain') === '', git('status', '--porcelain'))
  check('…and a build stamps it as the tree it is', stamp() === head)

  for (const name of names) {
    rmSync(join(repo, name), { recursive: true, force: true })
    mkdirSync(join(elsewhere, name), { recursive: true })
    writeFileSync(join(elsewhere, name, 'payload'), name)
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    symlinkSync(join(elsewhere, name), join(repo, name), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const openLinks = names.filter(name => !ignored(name))
  check(`each of the ${names.length} names is ignored where it stands as a link to a folder elsewhere`, openLinks.length === 0, openLinks.join(' '))
  check('a checkout whose packs are links has nothing to add', git('status', '--porcelain') === '', git('status', '--porcelain').split('\n').join(' · '))
  check('…and a build stamps it as the tree it is', stamp() === head)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? 'vendored packs ignored as folders and as links: ALL PASS' : `vendored packs ignored as folders and as links: FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
