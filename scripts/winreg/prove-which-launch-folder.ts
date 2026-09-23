#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  [PASS] ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const windows = process.platform === 'win32'
const node = process.env.MERCURY_NODE || Bun.which('node')
if (!node) {
  console.log('  [FAIL] no node on PATH to run the lookup outside Bun.which')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'mercury-which-'))
const launch = join(root, 'launch')
const listed = join(launch, 'bin')
mkdirSync(listed, { recursive: true })

function plant(dir: string, name: string): void {
  const file = join(dir, windows ? `${name}.exe` : name)
  writeFileSync(file, windows ? '' : '#!/bin/sh\nexit 0\n')
  if (!windows) chmodSync(file, 0o755)
}
plant(launch, 'zzplanted')
plant(launch, 'where')
plant(listed, 'zzlisted')

const probe = join(root, 'probe.mjs')
writeFileSync(
  probe,
  [
    "import { pathToFileURL } from 'node:url'",
    'const m = await import(pathToFileURL(process.argv[2]).href)',
    "console.log(JSON.stringify({ zzplanted: m.whichSync('zzplanted'), where: m.whichSync('where'), zzlisted: m.whichSync('zzlisted') }))",
  ].join('\n'),
)

const basePath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''

function lookupFrom(pathValue: string): Record<string, string | null> {
  const env: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH') env[key] = value
  env.PATH = pathValue
  const run = spawnSync(node as string, [probe, resolve(import.meta.dir, '../../src/utils/which.ts')], { cwd: launch, env, encoding: 'utf8' })
  try {
    return JSON.parse(run.stdout.trim())
  } catch {
    return { error: `${run.status} ${run.stderr.trim().split('\n').slice(-1)[0] ?? ''}` }
  }
}

const inLaunchFolder = (found: string | null): boolean =>
  found !== null && resolve(found).toLowerCase().startsWith(`${launch.toLowerCase()}${windows ? '\\' : '/'}`) && !resolve(found).toLowerCase().startsWith(listed.toLowerCase())

console.log('============================================================')
console.log(' which() and the launch folder')
console.log('============================================================')

const plain = lookupFrom(`${listed}${delimiter}${basePath}`)
check('a command that exists only in the launch folder is not found', plain.zzplanted === null, JSON.stringify(plain))
if (windows) check('a PATH command is not shadowed by a same-named file in the launch folder', !inLaunchFolder(plain.where) && plain.where !== null, JSON.stringify(plain))
check('a PATH entry inside the launch folder is still searched', plain.zzlisted !== null && resolve(plain.zzlisted).toLowerCase().startsWith(listed.toLowerCase()), JSON.stringify(plain))

const trailing = lookupFrom(`${listed}${delimiter}${basePath}${delimiter}`)
if (windows) {
  check('an empty PATH entry does not bring the launch folder back on Windows', trailing.zzplanted === null, JSON.stringify(trailing))
} else {
  check('an empty PATH entry still means the current directory on POSIX', trailing.zzplanted !== null, JSON.stringify(trailing))
}

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL WHICH LAUNCH-FOLDER CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
