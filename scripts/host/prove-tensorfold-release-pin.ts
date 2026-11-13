import { spawnSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const { TENSORFOLD_RELEASE, TENSORFOLD_RELEASE_BASE } = await import('../../src/services/tensorfold/starting.ts')
const { tensorFoldInstallPlan } = await import('../../src/services/tensorfold/install.ts')
const { TENSORFOLD_HOST_VERSION, TENSORFOLD_RELEASE_ARCHIVES, TENSORFOLD_RELEASE_PUBLIC_KEY, TENSORFOLD_RELEASE_SIGNED_PREFIX, tensorFoldEngineScript, tensorFoldHostRecipes } = await import('../../src/services/host/tensorfoldRelease.ts')

let checks = 0
let failures = 0
const check = (name: string, truth: boolean, detail = ''): void => {
  checks++
  if (!truth) failures++
  console.log((truth ? 'PASS ' : 'FAIL ') + name + (!truth && detail ? ' — ' + detail.slice(0, 400) : ''))
}
const fixtures = join(import.meta.dir, 'fixtures')
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'tensorfold-pin-'))
const key = createPublicKey('-----BEGIN PUBLIC KEY-----\n' + TENSORFOLD_RELEASE_PUBLIC_KEY + '\n-----END PUBLIC KEY-----\n')
const signedBy = (sidecar: Buffer, signature: Buffer): boolean => signature.length === 64 && verify(null, Buffer.concat([Buffer.from(TENSORFOLD_RELEASE_SIGNED_PREFIX), sidecar]), key, signature)
const read = (name: string): Buffer | undefined => existsSync(join(fixtures, name)) ? readFileSync(join(fixtures, name)) : undefined
const archiveOf = (platform: string): string => 'tensorfold-' + TENSORFOLD_RELEASE + '-' + platform + '.tar.gz'
const arches = [{ name: 'x86_64', uname: 'x86_64', node: 'x64' }, { name: 'aarch64', uname: 'aarch64', node: 'arm64' }] as const

try {
  check('the release has one owner: the pod table reads the pin, a dotted number, and both roads fetch from its tag', TENSORFOLD_HOST_VERSION === TENSORFOLD_RELEASE && /^\d+\.\d+\.\d+$/.test(TENSORFOLD_RELEASE) && TENSORFOLD_RELEASE_BASE === 'https://github.com/ashhart/TensorFold/releases/download/v' + TENSORFOLD_RELEASE, TENSORFOLD_HOST_VERSION + ' ' + TENSORFOLD_RELEASE + ' ' + TENSORFOLD_RELEASE_BASE)
  const expected = arches.flatMap(arch => [archiveOf(TENSORFOLD_RELEASE_ARCHIVES[arch.name].platform) + '.sha256', archiveOf(TENSORFOLD_RELEASE_ARCHIVES[arch.name].platform) + '.sha256.sig']).sort()
  const held = readdirSync(fixtures).filter(name => name.startsWith('tensorfold-')).sort()
  check('the fixtures folder holds the signed checksums of the pinned release and of no other: ' + expected.join(' '), held.join(' ') === expected.join(' '), 'holds ' + held.join(' '))

  const script = tensorFoldEngineScript(tensorFoldHostRecipes()[0]!, '/workspace/mercury-host/pin')
  const lines = script.split('\n').map(line => line.trim())
  const from = lines.findIndex(line => line.startsWith('case "$(uname -m)" in'))
  const to = lines.findIndex(line => line.startsWith('archive="tensorfold-'))
  const verifier = ['> release-key.pem', '> signed-checksum', 'openssl pkeyutl -verify', '"$expected  $archive"'].map(needle => lines.find(line => line.includes(needle)))
  check('the pod script still carries its four verifier lines after the lines that choose the archive and its digest by CPU', from >= 0 && to > from && verifier.every(line => line !== undefined) && script.includes("base='" + TENSORFOLD_RELEASE_BASE + "/'\"$archive\""), JSON.stringify({ from, to, verifier: verifier.map(line => line !== undefined) }))
  const bin = join(scratch, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'uname'), '#!/bin/bash\necho "$FIXTURE_UNAME"\n', { mode: 0o755 })
  const product = (work: string, uname: string): { status: number | null; out: string } => {
    writeFileSync(join(work, 'verify.sh'), ['set -e', ...lines.slice(from, to + 1), ...verifier.map(line => line ?? 'exit 97'), 'echo "VERIFIED $archive $expected"', ''].join('\n'))
    const run = spawnSync('bash', ['verify.sh'], { cwd: work, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH, FIXTURE_UNAME: uname }, timeout: 60_000 })
    return { status: run.status, out: (run.stdout + run.stderr).trim() }
  }

  for (const arch of arches) {
    const pinned = TENSORFOLD_RELEASE_ARCHIVES[arch.name]
    const archive = archiveOf(pinned.platform)
    const sidecar = read(archive + '.sha256')
    const signature = read(archive + '.sha256.sig')
    const text = sidecar?.toString('utf8') ?? ''
    check(arch.name + ': the fixture is the release\'s own line, the pinned digest and the pinned archive name and nothing else', text === pinned.sha256 + '  ' + archive + '\n' && /^[a-f0-9]{64}$/.test(pinned.sha256) && pinned.platform === 'linux-' + arch.name, JSON.stringify(text))
    check(arch.name + ': its signature verifies under the pinned key over the signed prefix (Node Ed25519)', sidecar !== undefined && signature !== undefined && signedBy(sidecar, signature), 'sidecar ' + (sidecar?.length ?? 'absent') + ' B, signature ' + (signature?.length ?? 'absent') + ' B')
    const other = sidecar === undefined ? undefined : Buffer.from(text.replace(/^./, first => first === '0' ? '1' : '0'))
    check(arch.name + ': the same signature does not cover a line whose digest differs in one character, nor the line without the prefix', sidecar !== undefined && signature !== undefined && other !== undefined && !signedBy(other, signature) && !(signature.length === 64 && verify(null, sidecar, key, signature)))
    const local = tensorFoldInstallPlan({ platform: 'linux', gpu: { name: 'NVIDIA GeForce RTX 4090', memoryBytes: 24 * 1024 ** 3, driver: '580.95', cuda: '13' } }, { platform: 'linux', arch: arch.node, home: '/home/u' })
    check(arch.name + ': the local install road fetches the archive the signed line names, and its checksum file, from the pinned tag', local.kind === 'archive' && text.endsWith('  ' + local.archive + '\n') && local.commands.includes('curl -fLO ' + TENSORFOLD_RELEASE_BASE + '/' + archive) && local.commands.includes('curl -fLO ' + TENSORFOLD_RELEASE_BASE + '/' + archive + '.sha256') && local.commands.includes('sha256sum -c ' + archive + '.sha256'), JSON.stringify(local))
    const work = join(scratch, arch.name); mkdirSync(work)
    for (const name of held) writeFileSync(join(work, name), readFileSync(join(fixtures, name)))
    const good = product(work, arch.uname)
    check(arch.name + ': the pod script\'s own lines choose this archive and digest for the CPU and verify the fixture under the pinned key (real openssl)', good.status === 0 && good.out.endsWith('VERIFIED ' + archive + ' ' + pinned.sha256), good.status + ' ' + good.out)
    if (signature !== undefined) writeFileSync(join(work, archive + '.sha256.sig'), Buffer.from(signature.map((byte, index) => index === 7 ? byte ^ 0xff : byte)))
    const tampered = product(work, arch.uname)
    check(arch.name + ': the same lines stop on a signature with one byte changed', signature !== undefined && tampered.status === 1 && tampered.out.includes('Release signature verification failed') && !tampered.out.includes('VERIFIED'), tampered.status + ' ' + tampered.out)
  }
  console.log('TENSORFOLD RELEASE PIN ' + (failures === 0 ? 'GREEN' : 'RED') + ' · ' + checks + ' checks · ' + failures + ' failed · the pin ' + TENSORFOLD_RELEASE + ', its two digests, its two signed fixtures and the archive names of both install roads')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
