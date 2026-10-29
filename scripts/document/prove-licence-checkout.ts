#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { vendorDocumentLibraries } from '../vendor/documentLibraries.ts'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

type Source = { name: string; version: string; file: string; sha256: string }
const lock = JSON.parse(readFileSync(join(ROOT, 'vendor/document-libs.lock.json'), 'utf8')) as { licenceSources: Source[] }
const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
const packageJson = readFileSync(join(ROOT, 'package.json'))
const licencePath = (source: Source): string => join('vendor', source.file)

writeFileSync(join(proofHome, 'gitconfig'), '')
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: join(proofHome, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim()

const origin = (name: string, gitattributes: string): string => {
  const dir = join(proofHome, name)
  mkdirSync(dir, { recursive: true })
  git(dir, '-c', 'init.defaultBranch=main', 'init', '-q')
  const put = (rel: string, bytes: Buffer | string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), bytes)
  }
  put('.gitattributes', gitattributes)
  put('package.json', packageJson)
  put('vendor/document-libs.lock.json', readFileSync(join(ROOT, 'vendor/document-libs.lock.json')))
  for (const source of lock.licenceSources) put(licencePath(source), readFileSync(join(ROOT, licencePath(source))))
  git(dir, '-c', 'core.autocrlf=false', 'add', '--', '.')
  git(dir, '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture')
  return dir
}
const crlfClone = (from: string, name: string): string => {
  const dir = join(proofHome, name)
  git(proofHome, '-c', 'core.autocrlf=true', 'clone', '-q', '--no-hardlinks', from, dir)
  return dir
}
const junctions: string[] = []
const withModules = (dir: string): string => {
  const link = join(dir, 'node_modules')
  symlinkSync(join(ROOT, 'node_modules'), link, 'junction')
  junctions.push(link)
  return dir
}
const vendored = async (root: string, out: string): Promise<{ error: string | null; shipped: Map<string, string> }> => {
  const launchCwd = process.cwd()
  process.chdir(root)
  try {
    await vendorDocumentLibraries(root, out)
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error), shipped: new Map() }
  } finally {
    process.chdir(launchCwd)
  }
  const shipped = new Map<string, string>()
  for (const source of lock.licenceSources) shipped.set(source.name, sha256(readFileSync(join(out, 'vendor/document-libs/licences', `${source.name}@${source.version}`, 'LICENSE'))))
  return { error: null, shipped }
}

const launchCwd = process.cwd()
try {
  check('the lock names at least one hash-locked licence file in the tree', lock.licenceSources.length >= 1, JSON.stringify(lock.licenceSources))

  section('§1 the rule: a core.autocrlf=true checkout of the tree delivers every hash-locked licence as the bytes the lock names; the same checkout without the rule converts them')
  const ruled = crlfClone(origin('origin-ruled', attributes), 'clone-ruled')
  const stripped = attributes.split('\n').filter(line => !line.includes('vendor/document-licences')).join('\n')
  const unruled = crlfClone(origin('origin-unruled', stripped), 'clone-unruled')
  check('the control fixture differs from the tree only by the licence rule', stripped !== attributes && stripped.length < attributes.length, 'no vendor/document-licences line in .gitattributes')
  for (const source of lock.licenceSources) {
    const rel = licencePath(source)
    const attr = git(ruled, 'check-attr', 'text', '--', `vendor/${source.file}`)
    check(`${source.name}: .gitattributes rules the licence out of line-end conversion (text unset)`, attr.endsWith(': text: unset'), attr)
    const ruledBytes = readFileSync(join(ruled, rel))
    check(`${source.name}: the autocrlf=true checkout with the rule delivers the lock's bytes`, sha256(ruledBytes) === source.sha256 && !ruledBytes.includes('\r\n'), `sha256 ${sha256(ruledBytes)} want ${source.sha256}`)
    const unruledBytes = readFileSync(join(unruled, rel))
    check(`${source.name}: the same checkout without the rule rewrites the file to CRLF (the exposure the rule closes)`, unruledBytes.includes('\r\n') && sha256(unruledBytes) !== source.sha256, `sha256 ${sha256(unruledBytes)}`)
  }

  section('§2 the comparison: the build reads a hash-locked licence the way the lock was made, so a CRLF checkout still vendors the lock\'s bytes')
  const crlfRoot = withModules(unruled)
  const fromCrlf = await vendored(crlfRoot, join(proofHome, 'out-crlf'))
  check('vendorDocumentLibraries over the CRLF checkout resolves without error', fromCrlf.error === null, fromCrlf.error ?? '')
  for (const source of lock.licenceSources) check(`${source.name}: the shipped licence is the lock's bytes, not the checkout's`, fromCrlf.shipped.get(source.name) === source.sha256, `shipped ${fromCrlf.shipped.get(source.name)} want ${source.sha256}`)
  const lfRoot = withModules(ruled)
  const fromLf = await vendored(lfRoot, join(proofHome, 'out-lf'))
  check('vendorDocumentLibraries over the byte-stable checkout resolves without error', fromLf.error === null, fromLf.error ?? '')
  for (const source of lock.licenceSources) check(`${source.name}: the shipped licence from the byte-stable checkout is the lock's bytes`, fromLf.shipped.get(source.name) === source.sha256, `shipped ${fromLf.shipped.get(source.name)} want ${source.sha256}`)

  section('§3 the lock still bites: a licence whose words differ is refused, line ends aside')
  const tampered = withModules(crlfClone(origin('origin-tampered', attributes), 'clone-tampered'))
  for (const source of lock.licenceSources) {
    const path = join(tampered, licencePath(source))
    const bytes = readFileSync(path)
    writeFileSync(path, Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([bytes[bytes.length - 1]! ^ 0x01])]))
  }
  const fromTampered = await vendored(tampered, join(proofHome, 'out-tampered'))
  check('a changed licence byte is refused with the lock\'s message', fromTampered.error !== null && /Document licence differs from its lock/.test(fromTampered.error), fromTampered.error ?? 'resolved')
} finally {
  process.chdir(launchCwd)
  for (const link of junctions) (process.platform === 'win32' ? rmdirSync : unlinkSync)(link)
  rmSync(proofHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
