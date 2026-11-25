#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { hostAssetName, makePayload } from './journeyFixtures.ts'

if (process.platform === 'win32') {
  console.log('prove-signed-archive: [SKIP] the staged release install is the POSIX one; the Windows road is walked by hand')
  process.exit(0)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sig-')))
const staged = stageInstall('release', join(SCRATCH, 'user'))
const versionsDir = join(staged.home, 'versions')
const was = readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
;(globalThis as Record<string, unknown>).MACRO = { VERSION: was }

const { keyIdOf, signArchive, signStatement } = await import('../../src/platform/update-channel/artifactSigning.js')
const { updateCeilings } = await import('../../src/platform/update-channel/archiveListing.js')
const { CHECKSUM_MANIFEST_NAME, SIGNED_ARCHIVES_FIRST_VERSION } = await import('../../src/platform/update-channel/channelCore.js')
const { releaseTargetFor } = await import('../../src/platform/update-channel/releaseTarget.js')
const { performUpdate } = await import('../../src/platform/update-channel/updateService.js')

const NEW = '9.9.0'
const keyOf = (): { pem: string; trusted: { keyId: string; publicKeySpkiB64: string; label: string } } => {
  const pair = generateKeyPairSync('ed25519')
  const publicKeySpkiB64 = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { pem: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), trusted: { keyId: keyIdOf(publicKeySpkiB64), publicKeySpkiB64, label: 'the release key of this proof' } }
}
const release = keyOf()
const stranger = keyOf()
const roster = [release.trusted]
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

type Served = { tag: string; assets: Record<string, Buffer> }
function releaseOf(version: string, alterManifest = false): { asset: string; archive: Buffer; sums: Buffer } {
  const stage = join(SCRATCH, `stage-${version}${alterManifest ? '-altered' : ''}`)
  const payload = join(stage, 'mercury')
  makePayload(payload, version)
  const manifestPath = join(payload, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { releaseLayout: { payloadDigest: string } }
  const signing = signStatement(
    { schema: 1, name: 'mercury', version, channel: 'private', target: releaseTargetFor(process.platform, process.arch) ?? 'unknown', packagedAt: '2026-11-25T00:00:00.000Z', buildTree: null, primarySha256: sha256(readFileSync(join(payload, 'mercury.mjs'))), payloadDigest: manifest.releaseLayout.payloadDigest, licenseId: null },
    release.pem,
  )
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, signing }, null, 2)}${alterManifest ? ' ' : '\n'}`)
  const asset = hostAssetName(version)
  const archivePath = join(stage, asset)
  execFileSync('tar', ['-czf', archivePath, '-C', stage, 'mercury'])
  const archive = readFileSync(archivePath)
  return { asset, archive, sums: Buffer.from(`${sha256(archive)}  ${asset}\n`) }
}
const signatureBy = (key: typeof release, of: { asset: string; archive: Buffer }): Buffer => Buffer.from(JSON.stringify(signArchive(of.asset, sha256(of.archive), key.pem)))

const served: Served = { tag: '', assets: {} }
const server = createServer((req, res) => {
  const url = req.url ?? ''
  const base = `http://${req.headers.host}`
  const json = (body: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (/^\/repos\/[^/]+\/[^/]+\/releases/.test(url)) return json([{ tag_name: served.tag, draft: false, assets: Object.keys(served.assets).map(name => ({ name, browser_download_url: `${base}/dl/${name}` })) }])
  if (/^\/repos\/[^/]+\/[^/]+$/.test(url)) return json({ private: false })
  const asset = served.assets[url.replace('/dl/', '')]
  if (asset !== undefined) return void res.end(asset)
  res.writeHead(404)
  res.end()
})
await new Promise<void>(listening => server.listen(0, '127.0.0.1', listening))
const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
process.env.MERCURY_UPDATE_API_BASE_URL = address
delete process.env.MERCURY_UPDATE_CHANNEL_REPO

type Outcome = { state: string; stage?: string; reason?: string; from?: string; to?: string; signature?: string; unsignedOverride?: boolean }
const roots = { versionsDir, binDir: staged.bin, shimPath: staged.command, isWindows: false }
const ONE_ENTRY = { ...updateCeilings(), entries: 1 }
async function update(tag: string, assets: Served['assets'], opts: Parameters<typeof performUpdate>[2] = {}, at = roots): Promise<Outcome> {
  Object.assign(served, { tag, assets })
  return (await performUpdate(at, () => {}, { roster, ...opts })) as Outcome
}
const mercury = (args: string[]): Promise<{ status: number | null; out: string }> =>
  new Promise(done => {
    const child = spawn(staged.command, args, { env: { ...staged.env, MERCURY_UPDATE_API_BASE_URL: address } })
    const said: Buffer[] = []
    child.stdout.on('data', chunk => said.push(chunk as Buffer))
    child.stderr.on('data', chunk => said.push(chunk as Buffer))
    child.on('close', status => done({ status, out: Buffer.concat(said).toString('utf8').trim() }))
  })
const pointer = (): string => readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
const layoutOf = (name: string, version: string): typeof roots => {
  const dir = join(SCRATCH, name)
  mkdirSync(join(dir, 'versions'), { recursive: true })
  makePayload(join(dir, 'versions', version), version)
  writeFileSync(join(dir, 'versions', 'current.txt'), `${version}\n`)
  return { versionsDir: join(dir, 'versions'), binDir: join(dir, 'bin'), shimPath: join(dir, 'bin', 'mercury'), isWindows: false }
}
const untouched = (): boolean => pointer() === was && !existsSync(join(versionsDir, NEW))
const told = (outcome: Outcome): string => JSON.stringify({ state: outcome.state, stage: outcome.stage, reason: outcome.reason }).slice(0, 400)

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix archiveSignatureRefusal in src/platform/update-channel/updateService.ts (it stands before extractArchive), archiveSignatureOf in src/platform/update-channel/channelCore.ts, or verifyArchiveSignature in src/platform/update-channel/artifactSigning.ts`}`)
}
const refusedUnopened = (outcome: Outcome, words: string): boolean => outcome.state === 'refused' && outcome.stage === 'archive-signature' && (outcome.reason ?? '').includes(words) && untouched()

console.log('============================================================')
console.log(' an update checks the archive against its own signature before it unpacks')
console.log('============================================================')
try {
  const good = releaseOf(NEW)
  const SIG = `${good.asset}.sig`
  const signature = signatureBy(release, good)
  const altered = releaseOf(NEW, true)

  console.log(`── v${was} installed; the release v${NEW}, at or above v${SIGNED_ARCHIVES_FIRST_VERSION}, the first whose archives are signed ──`)
  const forged = await update(`v${NEW}`, { [altered.asset]: altered.archive, [CHECKSUM_MANIFEST_NAME]: altered.sums, [SIG]: signature }, { ceilings: ONE_ENTRY })
  check('one byte of manifest.json altered and the sums rewritten for it: refused, the archive never opened', refusedUnopened(forged, `${SIG} does not vouch for the downloaded ${good.asset}`), told(forged))
  const swapped = await update(`v${NEW}`, { [altered.asset]: altered.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: signature }, { ceilings: ONE_ENTRY })
  check('the altered archive under the release\'s own sums: refused at the checksum, the archive never opened', swapped.state === 'refused' && swapped.stage === 'checksum' && untouched(), told(swapped))
  const resummed = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: altered.sums, [SIG]: signature }, { ceilings: ONE_ENTRY })
  check('the sums file altered: refused at the checksum, the archive never opened', resummed.state === 'refused' && resummed.stage === 'checksum' && untouched(), told(resummed))
  const renamed = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: Buffer.from(JSON.stringify(signArchive(`other-${good.asset}`, sha256(good.archive), release.pem))) }, { ceilings: ONE_ENTRY })
  check('a signature the release key made over another archive name: refused', refusedUnopened(renamed, `${SIG} does not vouch for the downloaded ${good.asset}`), told(renamed))
  const foreign = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: signatureBy(stranger, good) }, { ceilings: ONE_ENTRY, allowUnsigned: true })
  check('signed by a key outside the roster: refused, --allow-unsigned or not', refusedUnopened(foreign, `signed by key ${stranger.trusted.keyId}`), told(foreign))
  const stripped = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums }, { ceilings: ONE_ENTRY })
  check('the signature stripped: refused, and the sentence says it was removed', refusedUnopened(stripped, `carries no ${SIG}, and every release from v${SIGNED_ARCHIVES_FIRST_VERSION} on carries one`), told(stripped))
  const malformed: Array<[string, Buffer, string]> = [
    ['not JSON', Buffer.from('not a signature\n'), 'the signature file is not JSON'],
    ['the wrong shape', Buffer.from('{}'), 'signing schema undefined'],
    ['a signature of the wrong size', Buffer.from(JSON.stringify({ ...signArchive(good.asset, sha256(good.archive), release.pem), signatureB64: 'AAAA' })), `does not vouch for the downloaded ${good.asset}`],
  ]
  for (const [what, bytes, words] of malformed) {
    const outcome = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: bytes }, { ceilings: ONE_ENTRY, allowUnsigned: true })
    check(`a signature file that is ${what}: refused, --allow-unsigned or not`, refusedUnopened(outcome, words), told(outcome))
  }
  const huge = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: Buffer.alloc(updateCeilings().checksumManifestBytes + 1, 0x20) }, { ceilings: ONE_ENTRY, allowUnsigned: true })
  check('a signature file past the ceiling of a small release file: cut off at the download, the archive never opened', huge.state === 'refused' && huge.stage === 'download' && (huge.reason ?? '').includes(SIG) && untouched(), told(huge))
  const hostile = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: signature }, { ceilings: ONE_ENTRY })
  check('an archive that carries a VALID signature is still judged by the unpacker\'s own checks (here its entries ceiling)', hostile.state === 'refused' && hostile.stage === 'envelope' && untouched(), told(hostile))

  console.log(`── a prerelease OF v${SIGNED_ARCHIVES_FIRST_VERSION} is in the signed era ──`)
  const before = `${SIGNED_ARCHIVES_FIRST_VERSION}-beta.1`
  const candidate = releaseOf(`${SIGNED_ARCHIVES_FIRST_VERSION}-beta.2`)
  const early = await update(`v${SIGNED_ARCHIVES_FIRST_VERSION}-beta.2`, { [candidate.asset]: candidate.archive, [CHECKSUM_MANIFEST_NAME]: candidate.sums }, { ceilings: ONE_ENTRY }, layoutOf('prerelease', before))
  check(`v${before} installed, v${SIGNED_ARCHIVES_FIRST_VERSION}-beta.2 with no signature: refused, the archive never opened`, early.state === 'refused' && early.stage === 'archive-signature' && (early.reason ?? '').includes(`carries no ${candidate.asset}.sig`), told(early))

  console.log('── the exception, when it is what let a release through, is said and recorded ──')
  const excepted = layoutOf('excepted', '9.8.0')
  const through = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums }, { allowUnsigned: true }, excepted)
  const receipt = JSON.parse(readFileSync(join(excepted.versionsDir, 'last-update.json'), 'utf8')) as { signature?: string; unsignedOverride?: boolean }
  check('--allow-unsigned over a stripped signature and a signed payload: updated, and both the result and the receipt name the exception', through.state === 'updated' && through.signature === 'signed' && through.unsignedOverride === true && receipt.signature === 'signed' && receipt.unsignedOverride === true, `${JSON.stringify(through).slice(0, 300)} · ${JSON.stringify(receipt)}`)

  console.log('── the same two through the installed command ──')
  Object.assign(served, { tag: `v${NEW}`, assets: { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums } })
  const cliStripped = await mercury(['update'])
  check('mercury update, signature stripped: exit 1 at archive-signature with the removed sentence, nothing activated', cliStripped.status === 1 && cliStripped.out.includes(`update refused at archive-signature: release v${NEW} carries no ${SIG}`) && untouched(), cliStripped.out.slice(-500))
  Object.assign(served.assets, { [SIG]: signature })
  const cliForeign = await mercury(['update', '--allow-unsigned'])
  check('mercury update --allow-unsigned, a key the build does not carry: exit 1 at archive-signature', cliForeign.status === 1 && cliForeign.out.includes(`update refused at archive-signature: ${SIG} is signed by key ${release.trusted.keyId}`) && untouched(), cliForeign.out.slice(-500))

  console.log(`── an old release: below v${SIGNED_ARCHIVES_FIRST_VERSION}, no signature ──`)
  const old = releaseOf('1.0.12')
  const aged = await update('v1.0.12', { [old.asset]: old.archive, [CHECKSUM_MANIFEST_NAME]: old.sums }, {}, layoutOf('old', '1.0.11'))
  check('takes the road it took before: unpacked, judged by its payload signature, activated', aged.state === 'updated' && aged.to === '1.0.12' && aged.signature === 'signed', told(aged))

  console.log(`── the release v${NEW} with its signature ──`)
  const updated = await update(`v${NEW}`, { [good.asset]: good.archive, [CHECKSUM_MANIFEST_NAME]: good.sums, [SIG]: signature })
  check(`updated ${was} → ${NEW}, signed, no exception taken`, updated.state === 'updated' && updated.from === was && updated.to === NEW && updated.signature === 'signed' && updated.unsignedOverride === false && pointer() === NEW, JSON.stringify(updated).slice(0, 400))
  const version = await mercury(['--version'])
  check(`the installed command now answers Mercury ${NEW}`, version.status === 0 && version.out === `Mercury ${NEW}`, version.out.slice(-300))
} finally {
  await new Promise<void>(closed => server.close(() => closed()))
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-signed-archive: ALL HOLD' : `\nprove-signed-archive: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
