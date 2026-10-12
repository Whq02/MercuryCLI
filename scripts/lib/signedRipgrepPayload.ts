import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyIdOf, signStatement, type SigningStatementV1 } from '../../src/services/privateChannel/artifactSigning.js'
import type { TrustedSigningKey } from '../../src/services/privateChannel/signingTrust.js'
// @ts-expect-error — the packager-side authority is plain .mjs (no types)
import { readCompatFloor, releaseLayoutSection } from '../release/payloadContract.mjs'

const ROOT = join(import.meta.dir, '..', '..')

export const FIXTURE_VERSION = '9.9.9-beta.34'

export function platformRgDir(): string {
  return `${process.arch}-${process.platform}`
}

export function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function builtRipgrep(): string | null {
  const candidates = [
    join(ROOT, 'dist', 'vendor', 'ripgrep', platformRgDir(), 'rg'),
    join(ROOT, 'node_modules', '@vscode', `ripgrep-${process.platform}-${process.arch}`, 'bin', 'rg'),
    join(ROOT, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
  ]
  return candidates.find(c => existsSync(c)) ?? null
}

export function codesignFlags(path: string): string {
  const r = spawnSync('codesign', ['-dv', path], { encoding: 'utf8' })
  const line = `${r.stdout}\n${r.stderr}`.split('\n').find(l => l.includes('flags=')) ?? ''
  return line.replace(/.*flags=/, '').split(' ')[0] ?? ''
}

export function isLinkerSigned(path: string): boolean {
  return codesignFlags(path).includes('linker-signed')
}

export function makeLinkerSigned(path: string): void {
  execFileSync('codesign', ['--remove-signature', path], { stdio: 'ignore' })
  execFileSync('codesign', ['-s', '-', '--force', '-o', 'linker-signed', path], { stdio: 'ignore' })
}

export interface SignedPayloadFixture {
  dir: string
  rgPath: string
  rgSha256: string
  roster: TrustedSigningKey[]
}

export function buildSignedPayloadWithLinkerSignedRg(dir: string, opts: { primary?: string; launcher?: boolean } = {}): SignedPayloadFixture {
  const sourceRg = builtRipgrep()
  if (sourceRg === null) throw new Error('no built or dev-dependency ripgrep to vendor into the fixture payload')
  mkdirSync(dir, { recursive: true })
  if (opts.primary !== undefined) copyFileSync(opts.primary, join(dir, 'mercury.mjs'))
  else writeFileSync(join(dir, 'mercury.mjs'), `// fixture payload ${FIXTURE_VERSION}\n`)
  if (opts.launcher !== false) {
    writeFileSync(join(dir, 'mercury'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, 'mercury'), 0o755)
  }
  const rgDir = join(dir, 'vendor', 'ripgrep', platformRgDir())
  mkdirSync(rgDir, { recursive: true })
  const rgPath = join(rgDir, 'rg')
  copyFileSync(sourceRg, rgPath)
  chmodSync(rgPath, 0o755)
  if (process.platform === 'darwin') makeLinkerSigned(rgPath)
  const manifest: Record<string, unknown> = {
    schema: 2,
    name: 'mercury',
    version: FIXTURE_VERSION,
    buildTree: null,
    bundle: 'mercury.mjs',
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n')
  const rl = releaseLayoutSection(dir, 'macos-arm64', readCompatFloor()) as { primary: { sha256: string }; payloadDigest: string }
  manifest.releaseLayout = rl
  const pair = generateKeyPairSync('ed25519')
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const roster: TrustedSigningKey[] = [{ keyId: keyIdOf(spki), publicKeySpkiB64: spki, label: 'ephemeral prover key' }]
  const statement: SigningStatementV1 = {
    schema: 1,
    name: 'mercury',
    version: FIXTURE_VERSION,
    channel: 'private',
    target: 'macos-arm64',
    packagedAt: '2026-10-12T00:00:00.000Z',
    buildTree: null,
    primarySha256: rl.primary.sha256,
    payloadDigest: rl.payloadDigest,
    licenseId: null,
  }
  manifest.signing = signStatement(statement, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { dir, rgPath, rgSha256: sha256Of(rgPath), roster }
}

export function flipOneByte(path: string): void {
  const bytes = readFileSync(path)
  const at = Math.floor(bytes.length / 2)
  bytes[at] = (bytes[at]! ^ 0x01) & 0xff
  writeFileSync(path, bytes)
}
