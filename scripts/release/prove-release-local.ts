#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { keyIdOf, verifySignatureBlock } from '../../src/services/privateChannel/artifactSigning.ts'
import { archiveNameFor } from '../../src/services/privateChannel/releaseTarget.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const TARGET = 'macos-arm64'
const ENGINE = 'scripts/release/release-local.sh'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const finish = (scratch?: string): never => {
  console.log('')
  if (failures === 0) {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    console.log('PASS prove-release-local')
    process.exit(0)
  }
  if (scratch) console.log(`  scratch kept for reading: ${scratch}`)
  console.log(`FAIL prove-release-local (${failures})`)
  process.exit(1)
}

console.log(`release-local — the release workflow's package job on a machine of our own: ${TARGET}, a throwaway Ed25519 key`)

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.log(`  [SKIP] ${TARGET} is built natively on an Apple silicon Mac (host ${process.platform}/${process.arch})`)
  process.exit(0)
}
check(`${ENGINE} exists at this tree`, existsSync(join(ROOT, ENGINE)))
if (!existsSync(join(ROOT, ENGINE))) finish()
for (const tool of ['bash', 'bun', 'node', 'tar', 'git']) check(`${tool} is on PATH`, spawnSync(tool, ['--version'], { stdio: 'ignore' }).status === 0)
if (failures > 0) finish()

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const walk = (dir: string, base = ''): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(full).isDirectory()) Object.assign(out, walk(full, rel))
    else out[rel] = sha256File(full)
  }
  return out
}
const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, GIT_AUTHOR_NAME: 'release-local proof', GIT_AUTHOR_EMAIL: 'proof@release-local.invalid', GIT_COMMITTER_NAME: 'release-local proof', GIT_COMMITTER_EMAIL: 'proof@release-local.invalid' } }).trim()

const scratch = mkdtempSync(join(tmpdir(), 'mercury-release-local-'))
const snap = join(scratch, 'tree')
mkdirSync(snap)
{
  const listed = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(p => p && existsSync(join(ROOT, p)))
  const listFile = join(scratch, 'snapshot-list')
  writeFileSync(listFile, listed.join('\0') + '\0')
  const tarball = join(scratch, 'snapshot.tar')
  const packed = spawnSync('tar', ['-C', ROOT, '--null', '-T', listFile, '-cf', tarball], { encoding: 'utf8' })
  const unpacked = packed.status === 0 ? spawnSync('tar', ['-xf', tarball, '-C', snap], { encoding: 'utf8' }) : packed
  rmSync(tarball, { force: true })
  check(`the tree's ${listed.length} content files are snapshotted into scratch`, packed.status === 0 && unpacked.status === 0, ((packed.stderr ?? '') + (unpacked.stderr ?? '')).slice(0, 300))
  git(snap, ['init', '-q'])
  git(snap, ['add', '-A'])
  git(snap, ['commit', '-q', '-m', 'release-local proof: the tree as it stands'])
  symlinkSync(realpathSync(join(ROOT, 'node_modules')), join(snap, 'node_modules'))
  let linked = 0
  for (const entry of readdirSync(join(ROOT, 'vendor'))) {
    const src = join(ROOT, 'vendor', entry)
    if (!statSync(src).isDirectory() || existsSync(join(snap, 'vendor', entry))) continue
    symlinkSync(realpathSync(src), join(snap, 'vendor', entry))
    linked++
  }
  check('node_modules and the vendor packs are linked read-only into the snapshot (install, fetch and the native builds are skipped there)', lstatSync(join(snap, 'node_modules')).isSymbolicLink() && linked > 0, `${linked} vendor pack(s)`)
}

const pair = generateKeyPairSync('ed25519')
const keyFile = join(scratch, 'throwaway-ed25519.pem')
writeFileSync(keyFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o600 })
const spki = (pair.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64')
const keyId = keyIdOf(spki)
{
  const rosterPath = join(snap, 'src', 'services', 'privateChannel', 'signingTrust.ts')
  const before = readFileSync(rosterPath, 'utf8')
  const after = before
    .replace(/keyId: '[0-9a-f]{16}'/, `keyId: '${keyId}'`)
    .replace(/publicKeySpkiB64: '[A-Za-z0-9+/=]+'/, `publicKeySpkiB64: '${spki}'`)
    .replace(/label: '[^']*'/, "label: 'release-local proof key (throwaway)'")
  check('the snapshot compiles the throwaway public key into its trust roster (the one source line the snapshot differs by)', after !== before && after.includes(keyId) && after.includes(spki))
  writeFileSync(rosterPath, after)
  git(snap, ['add', '-A'])
  git(snap, ['commit', '-q', '-m', 'release-local proof: the throwaway key in the roster'])
}
if (failures > 0) finish(scratch)

const assets = join(scratch, 'assets')
const logs = join(scratch, 'logs')
const env: Record<string, string | undefined> = { ...process.env, MERCURY_SIGNING_KEY_FILE: keyFile, MERCURY_RELEASE_LOCAL_HOME: join(scratch, 'home') }
delete env.MERCURY_HOME
delete env.MERCURY_CONFIG_DIR
const started = Date.now()
const run = spawnSync('bash', [join(snap, ENGINE), '--target', TARGET, '--root', snap, '--out', assets, '--logs', logs, '--skip', 'install,fetch,native,bridge-reader', '--packager-flag', '--allow-stale-verify-receipts'], {
  encoding: 'utf8',
  env,
  timeout: 25 * 60_000,
  maxBuffer: 1 << 26,
})
console.log(`  · ${ENGINE} ran ${Math.round((Date.now() - started) / 1000)}s, exit ${run.status}:`)
for (const line of (run.stdout ?? '').split('\n').filter(Boolean)) console.log(`      ${line}`)
if (run.stderr) for (const line of run.stderr.split('\n').filter(Boolean).slice(0, 20)) console.log(`      stderr: ${line}`)
check(`${ENGINE} --target ${TARGET} exits 0 (the key never printed: no PEM line in its output)`, run.status === 0 && !/PRIVATE KEY/.test((run.stdout ?? '') + (run.stderr ?? '')))
for (const step of ['build', 'manifest', 'package', 'verify', 'collect', 'bridge-journey']) check(`step ${step} rc=0`, (run.stdout ?? '').includes(`step ${step} rc=0`))
for (const step of ['install', 'fetch', 'voice', 'bridge-reader']) check(`step ${step} skipped on request`, (run.stdout ?? '').includes(`step ${step} skipped`))
check('the TARGET line names the archive and its sha256', /^TARGET macos-arm64 OK archive=\S+ sha256=[0-9a-f]{64}$/m.test(run.stdout ?? ''))
if (run.status !== 0) finish(scratch)

const version = (JSON.parse(readFileSync(join(snap, 'package.json'), 'utf8')) as { version: string }).version
const name = archiveNameFor(version, TARGET)
const asset = join(assets, name)
check(`the collected archive carries the workflow's name: ${name}`, existsSync(asset))
if (!existsSync(asset)) finish(scratch)
const assetSha = sha256File(asset)
const sums = existsSync(join(assets, 'SHA256SUMS.txt')) ? readFileSync(join(assets, 'SHA256SUMS.txt'), 'utf8') : ''
check('SHA256SUMS.txt beside it carries the sha256sum row (<sha256>  <name>)', sums.split('\n').includes(`${assetSha}  ${name}`), sums.slice(0, 200))
check('the TARGET line states that sha256', (run.stdout ?? '').includes(`sha256=${assetSha}`))

const logNames = readdirSync(logs)
const logOf = (step: string): string => {
  const f = logNames.find(n => n.endsWith(`-${step}.log`))
  return f ? readFileSync(join(logs, f), 'utf8') : ''
}
check('the packager smoked the friend path inside the script run', logOf('package').includes('packaged + friend-path smoked'))
check(`the packager signed with the throwaway key ${keyId}`, logOf('package').includes(`signed: key ${keyId}`))
check('the verify step read the archive back at full depth and found it signed by that key', logOf('verify').includes(`signed by key ${keyId}`) && logOf('verify').includes('(deep, exit 0)'))
check('the verify step read the licence documents back out of the archive', logOf('verify').includes('Apache License 2.0 — LICENSE.md; NOTICE; TRADEMARKS.md'))
check('the bridge journey drove the update verbs against the candidate bundle', /PASS|pass/.test(logOf('bridge-journey')) && !/FAIL/.test(logOf('bridge-journey')))

const extractScript = join(scratch, 'extract-script')
mkdirSync(extractScript)
execFileSync('tar', ['-xzf', asset, '-C', extractScript])
const manifestScript = JSON.parse(readFileSync(join(extractScript, 'mercury', 'manifest.json'), 'utf8')) as { version: string; signing: unknown; releaseLayout: { payloadDigest: string; primary: { sha256: string } } }
{
  const binds = { manifestVersion: manifestScript.version, primarySha256: sha256File(join(extractScript, 'mercury', 'mercury.mjs')), payloadDigest: manifestScript.releaseLayout.payloadDigest }
  const verdict = verifySignatureBlock(manifestScript.signing, binds, [{ keyId, publicKeySpkiB64: spki, label: 'throwaway' }])
  check('the manifest signature verifies against the throwaway public key (content binds recomputed from the extracted bytes)', verdict.state === 'signed' && verdict.keyId === keyId, JSON.stringify(verdict).slice(0, 200))
  const stranger = verifySignatureBlock(manifestScript.signing, binds, [])
  check('the same signature is unrecognized under an empty roster (trust is the roster, never the embedded key)', stranger.state === 'unrecognized-key')
}

const vendoredNode = join(snap, 'vendor', 'node', 'extracted', 'darwin-arm64', 'bin', 'node')
const nodeBin = existsSync(vendoredNode) ? vendoredNode : 'node'
const directStarted = Date.now()
const direct = spawnSync(nodeBin, [join(snap, 'scripts', 'release', 'package.mjs'), '--target', TARGET, '--allow-stale-verify-receipts'], {
  cwd: snap,
  encoding: 'utf8',
  env: { ...env, MERCURY_CONFIG_DIR: join(scratch, 'home-direct'), MERCURY_CREDENTIAL_STORE: 'file', BROWSER: '/usr/bin/true', CI: '1', MERCURY_LOCAL_PROBE_TARGETS: 'none' },
  timeout: 20 * 60_000,
  maxBuffer: 1 << 26,
})
check(`package.mjs run directly with the same inputs packages too (${Math.round((Date.now() - directStarted) / 1000)}s)`, direct.status === 0, ((direct.stdout ?? '') + (direct.stderr ?? '')).slice(-400))
if (direct.status !== 0) finish(scratch)
const extractDirect = join(scratch, 'extract-direct')
mkdirSync(extractDirect)
execFileSync('tar', ['-xzf', join(snap, 'release-out', name), '-C', extractDirect])
const membersScript = walk(extractScript)
const membersDirect = walk(extractDirect)
check('both archives carry the same member list', JSON.stringify(Object.keys(membersScript)) === JSON.stringify(Object.keys(membersDirect)), `${Object.keys(membersScript).length} vs ${Object.keys(membersDirect).length}`)
const differing = Object.keys(membersScript).filter(p => p !== 'mercury/manifest.json' && membersScript[p] !== membersDirect[p])
check(`every member is byte-equal between the script's archive and the direct run (${Object.keys(membersScript).length} members, manifest.json aside)`, differing.length === 0, differing.slice(0, 5).join(', '))
const manifestDirect = JSON.parse(readFileSync(join(extractDirect, 'mercury', 'manifest.json'), 'utf8')) as { signing: { statement: { payloadDigest: string; primarySha256: string } }; releaseLayout: { payloadDigest: string } }
{
  const strip = (m: object): string => JSON.stringify({ ...(m as Record<string, unknown>), signing: undefined })
  check('manifest.json is equal apart from the signing block (the packaging time and the signature)', strip(manifestScript) === strip(manifestDirect))
  const s1 = (manifestScript.signing as { statement: { payloadDigest: string; primarySha256: string } }).statement
  const s2 = manifestDirect.signing.statement
  check('both signed statements bind the same payload digest and primary bundle', s1.payloadDigest === s2.payloadDigest && s1.primarySha256 === s2.primarySha256 && s1.payloadDigest === manifestDirect.releaseLayout.payloadDigest)
}

finish(scratch)
