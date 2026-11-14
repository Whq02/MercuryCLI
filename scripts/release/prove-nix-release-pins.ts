import { spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { payloadDigestOf, releaseLayoutSection, readCompatFloor } from './payloadContract.mjs'

const at = process.argv.indexOf('--source')
const root = resolve(at === -1 ? join(dirname(fileURLToPath(import.meta.url)), '../..') : process.argv[at + 1]!)
const script = join(root, 'scripts/release/refresh-nix-release-pins.mjs')
if (!existsSync(script)) {
  console.log('[FAIL] the finalized-release to Nix pins step is missing')
  process.exit(1)
}
const { refreshNixReleasePins, releasePins } = await import(pathToFileURL(script).href)
const ownerPath = join(root, 'dist/verify-artifact.mjs')
const owner = await import(pathToFileURL(ownerPath).href)
const scratch = mkdtempSync(join(tmpdir(), 'mercury-nix-pins-'))
const version = '9.9.9'
const targets = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64']
const keys = generateKeyPairSync('ed25519')
const publicKeySpkiB64 = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const roster = [{ keyId: owner.keyIdOf(publicKeySpkiB64), publicKeySpkiB64, label: 'ephemeral release fixture' }]
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const hash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
let checks = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
function fixture(name: string, change: string = ''): { archives: string; sums: string; out: string } {
  const archives = join(scratch, name)
  mkdirSync(archives)
  const sums: string[] = []
  for (const target of targets) {
    const stage = join(archives, `${target}-stage`)
    const payload = join(stage, 'mercury')
    mkdirSync(join(payload, 'vendor/node/bin'), { recursive: true })
    mkdirSync(join(payload, 'vendor/treesitter'), { recursive: true })
    for (const member of ['mercury.mjs', 'mercury', 'LICENSE.md', 'NOTICE', 'NOTICES.md', 'vendor/node/bin/node', 'vendor/treesitter/tree-sitter-json.wasm']) writeFileSync(join(payload, member), `fixture ${member}\n`)
    writeFileSync(join(payload, 'verify-artifact.mjs'), `import { verifyPayloadDir as verify } from ${JSON.stringify(pathToFileURL(ownerPath).href)}; export const verifyPayloadDir = (dir, options) => verify(dir, { ...options, roster: ${JSON.stringify(roster)} });\n`)
    const first = target === targets[0]
    const signedVersion = first && change === 'version' ? '9.9.8' : version
    const signedTarget = first && change === 'target' ? 'windows-x64' : target
    if (first && change === 'missing-grammar') rmSync(join(payload, 'vendor/treesitter/tree-sitter-json.wasm'))
    const manifest: any = { schema: 2, name: 'mercury', version: signedVersion, bundle: 'mercury.mjs', target: { release: signedTarget } }
    writeFileSync(join(payload, 'manifest.json'), JSON.stringify(manifest))
    manifest.releaseLayout = releaseLayoutSection(payload, target, readCompatFloor())
    manifest.signing = owner.signStatement({ schema: 1, name: 'mercury', version: signedVersion, target: signedTarget, channel: 'public', packagedAt: '2026-01-01T00:00:00.000Z', buildTree: null, primarySha256: hash(join(payload, 'mercury.mjs')), payloadDigest: payloadDigestOf(payload), licenseId: 'Apache-2.0' }, privateKey)
    if (first && change === 'unsigned') delete manifest.signing
    if (first && change === 'missing-member') manifest.releaseLayout.members.push({ path: 'absent-file', role: 'doc' })
    writeFileSync(join(payload, 'manifest.json'), JSON.stringify(manifest))
    if (first && change === 'tampered') writeFileSync(join(payload, 'NOTICE'), 'changed after signing\n')
    const archive = join(archives, owner.archiveNameFor(version, target))
    const packed = spawnSync('tar', ['-czf', archive, '-C', stage, 'mercury'], { encoding: 'utf8' })
    if (packed.status !== 0) throw new Error(packed.stderr)
    sums.push(`${hash(archive)}  ${owner.archiveNameFor(version, target)}`)
    rmSync(stage, { recursive: true })
  }
  const sumsPath = join(archives, 'SHA256SUMS.txt')
  writeFileSync(sumsPath, sums.join('\n') + '\n')
  const out = join(archives, 'release.json')
  writeFileSync(out, 'previous pins\n')
  return { archives, sums: sumsPath, out }
}
try {
  const good = fixture('good')
  const pinned = await refreshNixReleasePins({ ...good, version, owner })
  check('all four systems are generated from the release target authority', Object.values(pinned.systems).map((p: any) => p.target).join() === targets.join())
  check('all four public URLs and archive hashes are exact', Object.values(pinned.systems).every((p: any) => p.url === `https://github.com/Whq02/MercuryCLI/releases/download/v${version}/${owner.archiveNameFor(version, p.target)}` && p.sha256 === hash(join(good.archives, owner.archiveNameFor(version, p.target)))))
  const before = readFileSync(good.out, 'utf8')
  await refreshNixReleasePins({ ...good, version, owner, check: true })
  check('the check mode verifies the release and writes nothing', readFileSync(good.out, 'utf8') === before)
  check('the generated table is deterministic and holds no local path', before === JSON.stringify(releasePins(version, readFileSync(good.sums, 'utf8'), owner.archiveNameFor), null, 2) + '\n' && !before.includes(scratch))
  for (const [name, needle] of [['unsigned', 'not signed'], ['version', 'signed identity'], ['target', 'signed identity'], ['tampered', 'not signed'], ['missing-member', 'member'], ['missing-grammar', 'grammars'], ['checksum', 'SHA-256 mismatch'], ['missing-archive', 'missing finalized archive'], ['missing-system', 'has no'], ['duplicate', 'repeats'], ['malformed-sum', 'malformed row'], ['unsigned-name', 'has no']] as const) {
    const f = fixture(name, name)
    const text = readFileSync(f.sums, 'utf8')
    if (name === 'checksum') writeFileSync(f.sums, text.replace(/^[a-f0-9]{64}/, '0'.repeat(64)))
    if (name === 'missing-archive') rmSync(join(f.archives, owner.archiveNameFor(version, targets[0])))
    if (name === 'missing-system') writeFileSync(f.sums, text.split('\n').slice(1).join('\n'))
    if (name === 'duplicate') writeFileSync(f.sums, text + text.split('\n')[0] + '\n')
    if (name === 'malformed-sum') writeFileSync(f.sums, 'not a checksum\n' + text)
    if (name === 'unsigned-name') writeFileSync(f.sums, text.replace('linux-x64.tar.gz', 'linux-x64-unsigned.tar.gz'))
    let failure = ''
    try { await refreshNixReleasePins({ ...f, version, owner }) } catch (error) { failure = String(error) }
    check(`${name}: the release step names the failure before publishing pins`, failure.includes(needle), failure)
    check(`${name}: previous pins survive byte for byte`, readFileSync(f.out, 'utf8') === 'previous pins\n')
  }
  const changed = fixture('check-drift')
  let drift = ''
  try { await refreshNixReleasePins({ ...changed, version, owner, check: true }) } catch (error) { drift = String(error) }
  check('check mode names drift and does not overwrite it', drift.includes('differ') && readFileSync(changed.out, 'utf8') === 'previous pins\n')
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`prove-nix-release-pins: ${checks - failures}/${checks} passed`)
process.exitCode = failures ? 1 : 0
