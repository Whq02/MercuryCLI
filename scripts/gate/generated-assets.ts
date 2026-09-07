#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  GENERATED_ASSETS_MAP,
  generatedAssetsOwed,
  parseGeneratedAssetsMap,
  type GeneratedAssetRow,
} from '../../src/utils/hooks/generatedAssets.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(name)
const args = argv.filter(a => !['--check', '--all', '--verify-map', '--staged'].includes(a))

function usage(): never {
  console.error('usage: bun scripts/gate/generated-assets.ts <rev-range> | --staged | --paths <path…> [--check] | --all | --verify-map')
  process.exit(2)
}

function git(...gitArgs: string[]): string[] {
  return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

const map = parseGeneratedAssetsMap(readFileSync(join(ROOT, GENERATED_ASSETS_MAP), 'utf8'))
if (map.errors.length > 0) {
  for (const e of map.errors) console.error(`${GENERATED_ASSETS_MAP}: ${e}`)
  process.exit(1)
}

function scriptOf(command: string): string | null {
  return command.split(/\s+/).find(w => /[\\/]/.test(w) && !w.startsWith('-')) ?? null
}

if (flag('--verify-map')) {
  const tracked = new Set(git('ls-files'))
  let bad = 0
  for (const row of map.rows) {
    for (const asset of row.assets) {
      const isGlob = /[*?{]/.test(asset)
      const hit = isGlob ? [...tracked].some(t => new Bun.Glob(asset).match(t)) : tracked.has(asset)
      if (!hit) {
        bad++
        console.error(`line ${row.line}: asset ${asset} is not a tracked file`)
      }
    }
    for (const command of [row.generator, ...(row.check === null ? [] : [row.check])]) {
      for (const part of command.split('&&')) {
        const script = scriptOf(part)
        if (script !== null && !existsSync(join(ROOT, script))) {
          bad++
          console.error(`line ${row.line}: ${script} does not exist`)
        }
      }
    }
    for (const source of row.sources) {
      if (source.startsWith('files-of:') && !existsSync(join(ROOT, source.slice('files-of:'.length)))) {
        bad++
        console.error(`line ${row.line}: ${source} names a file that does not exist`)
      }
    }
  }
  console.log(`${GENERATED_ASSETS_MAP}: ${map.rows.length} row(s), ${bad} problem(s)`)
  process.exit(bad === 0 ? 0 : 1)
}

function runCheck(row: GeneratedAssetRow): number {
  if (row.check === null) {
    console.log(`── ${row.assets.join(' ')}  (no separate check)`)
    return 0
  }
  console.log(`── ${row.check}`)
  const res = spawnSync('bash', ['-c', row.check], { cwd: ROOT, stdio: 'inherit', env: process.env })
  const rc = res.status ?? 1
  console.log(`── ${row.check}  rc=${rc}`)
  return rc
}

if (flag('--all')) {
  let red = 0
  const seen = new Set<string>()
  for (const row of map.rows) {
    const key = row.check ?? row.assets.join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    if (runCheck(row) !== 0) red++
  }
  console.log(red === 0 ? `every generated asset is current (${seen.size} check(s))` : `${red} generated-asset check(s) red`)
  process.exit(red === 0 ? 0 : 1)
}

let paths: string[]
if (flag('--staged')) {
  paths = git('diff', '--cached', '--name-only')
} else if (args[0] === '--paths') {
  paths = args.slice(1)
  if (paths.length === 0) usage()
} else {
  const range = args[0]
  if (!range || range.startsWith('-')) usage()
  paths = git('diff', '--name-only', range)
  if (paths.length === 0) {
    console.error(`generated-assets: the range ${range} names no changed paths`)
    process.exit(2)
  }
}

const contentOf = (path: string): string | null => {
  try {
    const text = readFileSync(join(ROOT, path), 'utf8')
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}
const readFile = (path: string): string | null => {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
}
const owed = generatedAssetsOwed({ rows: map.rows, commitPaths: paths, contentOf, readFile, chainedVerifies: [] })
for (const o of owed) {
  console.log([o.row.assets.join(' '), o.row.generator, o.row.check ?? '-', [...new Set(o.touched.map(t => t.path))].join(' ')].join('\t'))
}
console.error(`generated-assets: ${paths.length} path(s) → ${owed.length} asset row(s) owed`)
if (flag('--check')) {
  let red = 0
  for (const o of owed) if (runCheck(o.row) !== 0) red++
  process.exit(red === 0 ? 0 : 1)
}
