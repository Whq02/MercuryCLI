#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const PACKAGE = 'sdk'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}

section('B1 the parked package is private and never reaches a registry')
const packageJson = JSON.parse(readFileSync(join(ROOT, PACKAGE, 'package.json'), 'utf8')) as Record<string, unknown>
check('package.json says private: true', packageJson.private === true)
check('no publishConfig', !('publishConfig' in packageJson))
const scripts = (packageJson.scripts ?? {}) as Record<string, string>
const publishWords = /publish|prepack|postpack|npm\s+(?:publish|login|token)/i
check('no publish, prepack or postpack script', Object.keys(scripts).every(name => !publishWords.test(name)) && Object.values(scripts).every(body => !publishWords.test(body)), JSON.stringify(scripts))
check('the name says draft', typeof packageJson.name === 'string' && /draft/.test(packageJson.name), String(packageJson.name))
check('no runtime dependencies (the package carries its own row vocabulary and interpreter)', packageJson.dependencies === undefined || Object.keys(packageJson.dependencies as object).length === 0)
const tracked = execFileSync('git', ['ls-files', '-z', PACKAGE], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
check(`the package's tracked files are under ${PACKAGE}/ (${tracked.length} files)`, tracked.length >= 10 && tracked.every(path => path.startsWith(`${PACKAGE}/`)))
check('no .npmrc, no lockfile, no node_modules and no dist are tracked', tracked.every(path => !/(^|\/)(\.npmrc|package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml)$/.test(path) && !path.includes('/node_modules/') && !path.startsWith(`${PACKAGE}/dist/`)), tracked.filter(path => /(^|\/)(\.npmrc|package-lock\.json|bun\.lock)$/.test(path) || path.includes('/node_modules/') || path.startsWith(`${PACKAGE}/dist/`)).join(','))
const sourceFiles = tracked.filter(path => path.startsWith(`${PACKAGE}/src/`) && path.endsWith('.ts'))
const registryNeedle = /\bfetch\s*\(|https?:\/\/|registry|NPM_TOKEN|npm_config|\.npmrc/i
const registryHits = sourceFiles.filter(path => registryNeedle.test(readFileSync(join(ROOT, path), 'utf8')))
check('the package source makes no network call, names no registry and reads no token', registryHits.length === 0, registryHits.join(','))
const readme = readFileSync(join(ROOT, PACKAGE, 'README.md'), 'utf8')
check('the README says it is a draft and that nothing is published', /draft/i.test(readme) && /not published|never published|nothing .* npm/i.test(readme))

section('B2 a clean copy of the tracked package builds with tsc into plain JavaScript and declarations')
const scratch = mkdtempSync(join(tmpdir(), 'sdk-build-'))
const copy = join(scratch, PACKAGE)
try {
  for (const path of tracked) {
    const target = join(scratch, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(ROOT, path), target)
  }
  symlinkSync(join(ROOT, 'node_modules'), join(copy, 'node_modules'))
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  check('the tree carries the TypeScript compiler the package build uses', existsSync(tsc))
  const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], { cwd: copy, encoding: 'utf8', timeout: 180_000 })
  check('tsc -p tsconfig.json exits 0 on the clean copy', build.status === 0, `${build.stdout}${build.stderr}`.slice(0, 1200))
  const dist = join(copy, 'dist')
  const built = existsSync(dist) ? readdirSync(dist).sort() : []
  const expected = sourceFiles.map(path => path.slice(`${PACKAGE}/src/`.length).replace(/\.ts$/, ''))
  check('every source module emits a .js and a .d.ts', expected.every(stem => built.includes(`${stem}.js`) && built.includes(`${stem}.d.ts`)), JSON.stringify({ expected, built }))
  const foreignImports: string[] = []
  for (const name of built.filter(file => file.endsWith('.js'))) {
    const text = readFileSync(join(dist, name), 'utf8')
    for (const m of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3]!
      if (!spec.startsWith('node:') && !spec.startsWith('./')) foreignImports.push(`${name}: ${spec}`)
    }
  }
  check('the built JavaScript imports nothing but node builtins and its own modules (self-contained when copied out of the tree)', foreignImports.length === 0, foreignImports.join(', '))
  const probe = [
    `const sdk = await import(${JSON.stringify(join(dist, 'index.js'))})`,
    "const names = ['run', 'argvOf', 'MercuryRun', 'parseRow', 'rowOf', 'validate', 'ROW_TYPES', 'PARTIAL_ROW_TYPES', 'ROW_SCHEMAS', 'RUN_OPTIONS', 'OUTCOME_EXIT_CODES', 'MercuryRefusal', 'MercuryUsageError', 'MercuryExitError', 'MercurySpawnError', 'MercuryWireError']",
    'const missing = names.filter(name => !(name in sdk))',
    "const read = sdk.parseRow(JSON.stringify({ type: 'heartbeat', seq: 1, timestamp: 't', session_id: 's' }))",
    "const argv = sdk.argvOf({ prompt: 'hello', model: 'm' })",
    "process.stdout.write(JSON.stringify({ missing, read, argv, types: sdk.ROW_TYPES.length + sdk.PARTIAL_ROW_TYPES.length, schemas: Object.keys(sdk.ROW_SCHEMAS).length }))",
  ].join('\n')
  const load = spawnSync('node', ['--input-type=module', '-e', probe], { cwd: scratch, encoding: 'utf8', timeout: 60_000 })
  let loaded: { missing: string[]; read: { ok: boolean }; argv: { command: string; args: string[] }; types: number; schemas: number } | null = null
  try {
    loaded = JSON.parse(load.stdout) as typeof loaded
  } catch {
    loaded = null
  }
  check('the built package loads under plain node', load.status === 0 && loaded !== null, `${load.stdout}${load.stderr}`.slice(0, 600))
  check('it exports the client, the reader, the interpreter, the vocabulary and the five error classes', loaded !== null && loaded.missing.length === 0, JSON.stringify(loaded?.missing))
  check('the built reader parses a row and the built argv builder spells the run door', loaded !== null && loaded.read.ok === true && loaded.argv.command === 'mercury' && loaded.argv.args.join(' ') === 'run --format rows --model m -- hello', JSON.stringify(loaded))
  check('one schema per declared row type in the built package', loaded !== null && loaded.schemas === loaded.types && loaded.types > 0, JSON.stringify(loaded))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-sdk-build: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-sdk-build: the parked package is private, self-contained and builds from a clean copy')
