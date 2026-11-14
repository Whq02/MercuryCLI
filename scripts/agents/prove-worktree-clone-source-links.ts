#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { mock } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import * as promises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneRoadExpected, volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
const mode = process.argv[2]
const read = (path: string): string => {
  try { return readFileSync(path, 'utf8') } catch { return '<absent>' }
}
if (mode !== undefined) {
  const scratch = process.argv[3] as string
  const checkout = join(scratch, '-checkout\nsource')
  const source = join(checkout, 'node_modules')
  const outside = join(scratch, 'outside')
  const worktree = join(checkout, '.mercury', 'worktrees', 'agent-a123abcd')
  const replacedPath = mode === 'walk-nested' ? join(source, 'nested') : source
  mkdirSync(replacedPath, { recursive: true })
  mkdirSync(join(outside, 'other-tree'), { recursive: true })
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(replacedPath, 'file'), 'dependency')
  writeFileSync(join(outside, 'file'), 'outside file')
  writeFileSync(join(outside, 'other-tree', '.git'), 'gitdir: fixture')
  writeFileSync(join(outside, 'other-tree', 'precious'), 'keep me')
  symlinkSync(join(checkout, 'target'), join(outside, 'link'))
  let replaced = false
  const replace = (): void => {
    if (replaced) return
    replaced = true
    renameSync(replacedPath, replacedPath + '-kept')
    symlinkSync(outside, replacedPath)
  }
  if (mode === 'walk' || mode === 'walk-nested') {
    process.env.MERCURY_WORKTREE_CLONE = 'files'
    const copy = promises.copyFile
    const originalStat = promises.lstat
    mock.module('node:fs/promises', () => ({
      ...promises,
      lstat: async (...args: Parameters<typeof originalStat>): ReturnType<typeof originalStat> => {
        if (mode === 'walk-nested' && String(args[0]) === replacedPath) replace()
        return originalStat(...args)
      },
      copyFile: async (from: string, to: string, flags?: number): Promise<void> => {
        await copy(from, to, flags)
        if (mode === 'walk' && to.includes('.clone-probe-')) replace()
      },
    }))
  } else {
    if (mode === 'cp') process.env.MERCURY_WORKTREE_CLONE = 'cp'
    else delete process.env.MERCURY_WORKTREE_CLONE
    const exec = await import('../../src/utils/execFileNoThrow.ts')
    const original = exec.execFileNoThrowWithCwd
    mock.module('../../src/utils/execFileNoThrow.ts', () => ({
      ...exec,
      execFileNoThrowWithCwd: (...args: Parameters<typeof original>): ReturnType<typeof original> => {
        if (args[0] === '/usr/bin/osascript' || (args[0] === 'cp' && args[1][0] === '-a')) replace()
        return original(...args)
      },
    }))
  }
  const { cloneIntoWorktree } = await import('../../src/utils/worktreeClone.ts')
  const outcome = await cloneIntoWorktree([{ source, target: join(worktree, 'node_modules') }], checkout, worktree)
  const atName = join(worktree, 'node_modules')
  const nestedLink = mode === 'walk-nested' && existsSync(atName) && lstatSync(join(atName, 'nested')).isSymbolicLink() && realpathSync(join(atName, 'nested')) === outside
  console.log('RESULT ' + JSON.stringify({ replaced, outcome: outcome[0], precious: read(join(outside, 'other-tree', 'precious')), outsideLink: readlinkSync(join(outside, 'link')) === join(checkout, 'target'), source: read(join(replacedPath + '-kept', 'file')), nestedLink, published: existsSync(atName) || (() => { try { return lstatSync(atName).isSymbolicLink() } catch { return false } })() }))
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-source-links-')))
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
try {
  const roads = process.platform === 'darwin' && cloneRoadExpected(scratch) ? ['apfs'] : []
  if (process.platform === 'linux' && cloneRoadExpected(scratch)) roads.push('cp')
  if (process.platform !== 'win32' && volumeClones(scratch)) roads.push('walk', 'walk-nested')
  if (roads.length === 0) console.log('  [SKIP] this volume or platform cannot clone: the existing dependency links stand')
  for (const road of roads) {
    const place = join(scratch, road)
    mkdirSync(place)
    const child = spawnSync(process.execPath, [import.meta.path, road, place], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: process.env })
    const line = child.stdout.split('\n').find(row => row.startsWith('RESULT '))
    check(`${road}: the source is replaced between admission and the copy`, child.status === 0 && line !== undefined, child.stderr)
    if (line === undefined) continue
    const result = JSON.parse(line.slice(7)) as { replaced: boolean; outcome: string; precious: string; outsideLink: boolean; source: string; nestedLink: boolean; published: boolean }
    check(`${road}: the replacement seam ran`, result.replaced)
    check(`${road}: the outside worktree's file is never removed`, result.precious === 'keep me', JSON.stringify(result))
    check(`${road}: the outside link is never rewritten`, result.outsideLink, JSON.stringify(result))
    check(`${road}: the source's original files remain whole`, result.source === 'dependency')
    if (road === 'walk-nested') check(`${road}: a nested folder changed to a link is carried as the link`, result.outcome === 'cloned' && result.nestedLink, JSON.stringify(result))
    else check(`${road}: a changed source is not published as a private clone`, result.outcome === 'failed' && !result.published, JSON.stringify(result))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
