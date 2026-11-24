#!/usr/bin/env bun
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { keyIdOf, signStatement, type SigningStatementV1 } from '../../src/platform/update-channel/artifactSigning.js'
import { verifyPayloadDir } from '../../src/platform/update-channel/artifactVerify.js'
import { smokeVersion } from '../../src/platform/update-channel/installLayout.js'
import { payloadVendoredRuntime } from '../../src/platform/update-channel/vendoredRuntime.js'
import type { TrustedSigningKey } from '../../src/platform/update-channel/signingTrust.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')
const { readCompatFloor, releaseLayoutSection } = await import(pathToFileURL(join(import.meta.dir, '../release/payloadContract.mjs')).href)

const scratch = mkdtempSync(join(tmpdir(), 'mercury-o01-manifest-'))
try {
  const pair = generateKeyPairSync('ed25519')
  const pem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const roster: TrustedSigningKey[] = [{ keyId: keyIdOf(spki), publicKeySpkiB64: spki, label: 'ephemeral release key' }]

  const payloadDir = join(scratch, 'mercury')
  mkdirSync(join(payloadDir, 'vendor', 'node', 'bin'), { recursive: true })
  mkdirSync(join(payloadDir, 'vendor', 'ripgrep'), { recursive: true })
  writeFileSync(join(payloadDir, 'mercury.mjs'), "console.log('Mercury 9.9.9-beta.1')\n")
  writeFileSync(join(payloadDir, 'mercury'), '#!/bin/sh\nexit 0\n')
  writeFileSync(join(payloadDir, 'vendor', 'node', 'bin', 'node'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(payloadDir, 'vendor', 'node', 'bin', 'node'), 0o755)
  writeFileSync(join(payloadDir, 'vendor', 'ripgrep', 'rg'), '')

  const manifest: Record<string, unknown> = {
    schema: 2,
    name: 'mercury',
    version: '9.9.9-beta.1',
    buildTree: 'f'.repeat(40),
    bundle: 'mercury.mjs',
    runtime: {
      vendored: true,
      path: 'vendor/node',
      binary: 'bin/node',
      name: 'node',
      version: '24.22.1',
      platform: 'darwin-arm64',
      license: 'MIT',
      archiveSha256: 'a'.repeat(64),
      binarySha256: sha256(join(payloadDir, 'vendor', 'node', 'bin', 'node')),
    },
  }
  writeFileSync(join(payloadDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  const rl = releaseLayoutSection(payloadDir, 'macos-arm64', readCompatFloor()) as {
    primary: { sha256: string }
    payloadDigest: string
  }
  manifest.releaseLayout = rl
  const statement: SigningStatementV1 = {
    schema: 1,
    name: 'mercury',
    version: '9.9.9-beta.1',
    channel: 'private',
    target: 'macos-arm64',
    packagedAt: '2026-11-24T00:00:00.000Z',
    buildTree: 'f'.repeat(40),
    primarySha256: rl.primary.sha256,
    payloadDigest: rl.payloadDigest,
    licenseId: null,
  }
  manifest.signing = signStatement(statement, pem)
  writeFileSync(join(payloadDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  const baseline = verifyPayloadDir(payloadDir, { depth: 'deep', roster })
  check('setup: unmodified signed payload verifies as signed at deep depth', baseline.verdict.state === 'signed', JSON.stringify(baseline.verdict))
  const inside = payloadVendoredRuntime(payloadDir)
  check('a manifest whose runtime path stays inside the payload names that binary for the smoke and the launcher', inside !== null && inside.binaryPath === join(payloadDir, 'vendor', 'node', 'bin', 'node'), JSON.stringify(inside))

  const sentinel = join(scratch, 'outside-executed.sentinel')
  const outsideBin = join(scratch, 'outside-evil.sh')
  writeFileSync(outsideBin, `#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\necho "Mercury 9.9.9-beta.1"\n`)
  chmodSync(outsideBin, 0o755)

  const tamperedManifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  tamperedManifest.runtime = {
    ...(tamperedManifest.runtime as Record<string, unknown>),
    path: '..',
    binary: 'outside-evil.sh',
    binarySha256: sha256(outsideBin),
  }
  writeFileSync(join(payloadDir, 'manifest.json'), JSON.stringify(tamperedManifest, null, 2) + '\n')

  const afterTamper = verifyPayloadDir(payloadDir, { depth: 'deep', roster })
  check(
    'O-01: verifyPayloadDir(deep) refuses manifest whose runtime path escapes the payload directory',
    afterTamper.verdict.state !== 'signed',
    `verdict=${JSON.stringify(afterTamper.verdict)}`,
  )

  check('O-01: the verdict says tampered and names the declared file as absent from the payload', afterTamper.verdict.state === 'tampered' && afterTamper.verdict.note.includes('but the file is absent'), JSON.stringify(afterTamper.verdict))
  const named = payloadVendoredRuntime(payloadDir)
  check('O-01: the place that builds the binary path for the smoke and the launcher names no binary outside the payload', named === null, JSON.stringify(named))
  const smoked = smokeVersion(payloadDir, '9.9.9-beta.1', 'mercury.mjs')
  check('O-01: the smoke of such a payload does not run the file outside it', !existsSync(sentinel), `sentinelExists=${existsSync(sentinel)} smoke=${JSON.stringify(smoked)}`)

  const pythonManifest = JSON.parse(readFileSync(join(payloadDir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  pythonManifest.runtime = manifest.runtime
  pythonManifest.pythonRuntime = { vendored: true, path: '..', binary: 'outside-evil.sh', name: 'python', version: '3.13.0', release: '20260101', platform: 'darwin-arm64', license: 'PSF-2.0', archiveSha256: 'a'.repeat(64), binarySha256: sha256(outsideBin) }
  writeFileSync(join(payloadDir, 'manifest.json'), JSON.stringify(pythonManifest, null, 2) + '\n')
  const pythonTamper = verifyPayloadDir(payloadDir, { depth: 'deep', roster })
  check('O-01: a pythonRuntime path that climbs out of the payload is refused the same way', pythonTamper.verdict.state === 'tampered', JSON.stringify(pythonTamper.verdict))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-manifest-runtime-path-traversal: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
