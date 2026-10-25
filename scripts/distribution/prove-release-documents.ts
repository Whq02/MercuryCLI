#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const documents = (await import('../release/payloadContract.mjs')) as { DOC_SET: string[]; memberRole: (name: string) => string; topAllowlist: (target: string, floor: unknown) => string[]; readCompatFloor: () => unknown }
const owner = (await import('../release/releaseDocuments.mjs')) as {
  LICENCE_DOCUMENTS: string[]
  LICENCE_FILE: string
  readLicenceParameters: (text: string) => { bodySha256: string; notice: boolean }
  checkReleaseDocuments: (o: { root: string; archiveDir?: string | null }) => { ok: boolean; findings: string[] }
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const refused = (r: { ok: boolean; findings: string[] }, needle: string): boolean => !r.ok && r.findings.some(f => f.includes(needle))
const detailOf = (r: { findings: string[] }): string => r.findings.join(' | ')

console.log('release documents — Apache License 2.0')

const LICENCE = readFileSync(join(ROOT, owner.LICENCE_FILE), 'utf8')
const APACHE = readFileSync(join(ROOT, 'sdk/LICENSE'), 'utf8')
const BODY_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
const COPYRIGHT = 'Copyright 2026 Waleed Al Qusous, trading as Mercury CLI'
const SCRATCH = mkdtempSync(join(tmpdir(), 'release-documents-'))

function fixtureTree(name: string, edit: (licence: string) => string = t => t, drop: string[] = []): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  for (const doc of owner.LICENCE_DOCUMENTS) {
    if (drop.includes(doc)) continue
    writeFileSync(join(dir, doc), doc === owner.LICENCE_FILE ? edit(LICENCE) : readFileSync(join(ROOT, doc)))
  }
  return dir
}

try {
  section('§1 the tree — Apache text, copyright and licence pointers')
  {
    const p = owner.readLicenceParameters(LICENCE)
    check('the licence body matches the Apache text and the SDK copy byte for byte', sha256(APACHE) === BODY_SHA256 && p.bodySha256 === BODY_SHA256 && LICENCE.startsWith(APACHE))
    check('the appended notice names the copyright holder and uses the Apache boilerplate', p.notice && LICENCE.slice(APACHE.length) === '\n' + APACHE.slice(APACHE.indexOf('   Copyright [yyyy]')).replace('Copyright [yyyy] [name of copyright owner]', COPYRIGHT).replace(/^ {3}/gm, ''))
    check('NOTICE contains only the product and copyright lines', readFileSync(join(ROOT, 'NOTICE'), 'utf8') === `Mercury CLI\n${COPYRIGHT}\n`)
    check('the document set is LICENSE.md, NOTICE and TRADEMARKS.md', JSON.stringify(owner.LICENCE_DOCUMENTS) === JSON.stringify(['LICENSE.md', 'NOTICE', 'TRADEMARKS.md']))
    const SDK_DIRS = ['sdk', 'sdk-py']
    check('the SDKs retain the same Apache text', SDK_DIRS.every(d => readFileSync(join(ROOT, d, 'LICENSE'), 'utf8') === APACHE))
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    check('README.md badge names Apache-2.0 and links LICENSE.md', readme.includes('<a href="LICENSE.md"><img alt="licence Apache-2.0" src="https://img.shields.io/badge/licence-Apache--2.0-blue?style=flat"></a>'))
    check('README.md top line names the CLI and SDKs under Apache License 2.0', readme.includes('Mercury is open source under the Apache License 2.0, as are the SDKs in [sdk/](sdk/) and [sdk-py/](sdk-py/).'))
    const readmeLicence = readme.split('\n## Licence\n\n')[1] ?? ''
    check('README.md Licence section names Apache-2.0 and links the licence and trademark policy', readmeLicence.startsWith('The Mercury CLI is licensed under the Apache License 2.0 (`Apache-2.0`); see\n[LICENSE.md](LICENSE.md).') && readmeLicence.includes('[trademark policy](TRADEMARKS.md)') && readmeLicence.includes('[sdk/LICENSE](sdk/LICENSE)') && readmeLicence.includes('[sdk-py/LICENSE](sdk-py/LICENSE)'))
    const sdkLicenceSection = '## Licence\n\nLicensed under the Apache License 2.0 (`Apache-2.0`); see [LICENSE](LICENSE). The Mercury CLI is licensed under the same licence.'
    for (const d of SDK_DIRS) check(`${d}/README.md names the same licence for the CLI`, readFileSync(join(ROOT, d, 'README.md'), 'utf8').includes(sdkLicenceSection))
    const sdkPkg = JSON.parse(readFileSync(join(ROOT, 'sdk/package.json'), 'utf8')) as { name?: string; license?: string; files?: string[] }
    const sdkPyproject = readFileSync(join(ROOT, 'sdk-py/pyproject.toml'), 'utf8')
    check('SDK metadata declares Apache-2.0 and ships LICENSE', sdkPkg.name === 'mercury-cli-sdk' && sdkPkg.license === 'Apache-2.0' && Array.isArray(sdkPkg.files) && sdkPkg.files.includes('LICENSE') && /^name = "mercury-cli-sdk"$/m.test(sdkPyproject) && /^license = "Apache-2.0"$/m.test(sdkPyproject) && /^license-files = \["LICENSE"\]$/m.test(sdkPyproject))
    const tree = owner.checkReleaseDocuments({ root: ROOT })
    check('the documents check passes the tree', tree.ok, detailOf(tree))
  }

  section('§2 altered text, attribution and missing documents are refused')
  {
    for (const [name, edit] of [
      ['body', (t: string) => t.replace('perpetual,', 'temporary,')],
      ['prefix', (t: string) => 'Additional condition\n' + t],
      ['suffix', (t: string) => t + '\nAdditional condition\n'],
      ['truncated', (t: string) => t.slice(t.indexOf('   2. Grant'))],
    ] as const) {
      check(`${name} mutation is refused`, refused(owner.checkReleaseDocuments({ root: fixtureTree(name, edit) }), 'verbatim Apache License 2.0'))
    }
    for (const [name, edit] of [
      ['no-notice', () => APACHE],
      ['holder', (t: string) => t.replace(COPYRIGHT, 'Copyright 2026 Someone Else')],
      ['boilerplate', (t: string) => t.replace(/limitations under the License\.\n$/, 'different terms\n')],
    ] as const) {
      check(`${name} mutation is refused`, refused(owner.checkReleaseDocuments({ root: fixtureTree(name, edit) }), 'copyright notice'))
    }
    const wrongNotice = fixtureTree('wrong-notice')
    writeFileSync(join(wrongNotice, 'NOTICE'), 'Mercury CLI\n')
    check('an incomplete NOTICE is refused', refused(owner.checkReleaseDocuments({ root: wrongNotice }), 'NOTICE must name'))
    for (const doc of owner.LICENCE_DOCUMENTS) {
      check(`missing ${doc} is refused`, refused(owner.checkReleaseDocuments({ root: fixtureTree(`missing-document-${doc}`, t => t, [doc]) }), `${doc} is missing`))
    }
    const placeholder = fixtureTree('trademark-placeholder')
    writeFileSync(join(placeholder, 'TRADEMARKS.md'), '[INSERT POLICY]\n')
    check('a trademark-policy placeholder is refused', refused(owner.checkReleaseDocuments({ root: placeholder }), 'placeholder'))
  }

  section('§3 release checks never change the licence documents')
  {
    check('the module exposes only the document list and readers', Object.keys(owner).sort().join(',') === ['LICENCE_DOCUMENTS', 'LICENCE_FILE', 'checkReleaseDocuments', 'readLicenceParameters'].sort().join(','))
    const dir = fixtureTree('release')
    const before = owner.LICENCE_DOCUMENTS.map(doc => readFileSync(join(dir, doc)))
    for (const version of ['1.0.0', '2.0.0']) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
      const result = spawnSync('node', [join(ROOT, 'scripts/release/releaseDocuments.mjs'), 'check', '--root', dir], { encoding: 'utf8' })
      check(`the CLI check passes for ${version} without changing any document`, result.status === 0 && owner.LICENCE_DOCUMENTS.every((doc, i) => readFileSync(join(dir, doc)).equals(before[i]!)), result.stderr)
    }
    const unknown = spawnSync('node', [join(ROOT, 'scripts/release/releaseDocuments.mjs'), 'unknown', '--root', dir], { encoding: 'utf8' })
    check('an unknown verb is refused without writing', unknown.status === 2 && owner.LICENCE_DOCUMENTS.every((doc, i) => readFileSync(join(dir, doc)).equals(before[i]!)))
    const option = spawnSync('node', [join(ROOT, 'scripts/release/releaseDocuments.mjs'), 'check', '--unknown', 'value', '--root', dir], { encoding: 'utf8' })
    check('an unknown option is refused', option.status === 2)
    const bad = fixtureTree('cli-bad', t => t + 'extra')
    check('the CLI check exits 1 on an altered licence', spawnSync('node', [join(ROOT, 'scripts/release/releaseDocuments.mjs'), 'check', '--root', bad]).status === 1)
  }

  section('§4 the archive carries all three documents verbatim')
  {
    for (const doc of owner.LICENCE_DOCUMENTS) check(`${doc} is a doc member of the payload contract`, documents.DOC_SET.includes(doc) && documents.memberRole(doc) === 'doc')
    const floor = documents.readCompatFloor()
    check('both platform allowlists carry all three documents', ['linux-x64', 'windows-x64'].every(t => owner.LICENCE_DOCUMENTS.every(d => documents.topAllowlist(t, floor).includes(d))))
    const archive = fixtureTree('archive')
    const good = owner.checkReleaseDocuments({ root: ROOT, archiveDir: archive })
    check('a verbatim archive passes', good.ok, detailOf(good))
    check('the CLI reads an archive', spawnSync('node', [join(ROOT, 'scripts/release/releaseDocuments.mjs'), 'check', '--root', ROOT, '--archive', archive]).status === 0)
    for (const doc of owner.LICENCE_DOCUMENTS) {
      const missing = fixtureTree(`archive-missing-${doc}`, t => t, [doc])
      check(`an archive missing ${doc} is refused`, refused(owner.checkReleaseDocuments({ root: ROOT, archiveDir: missing }), `missing ${doc}`))
      const differs = fixtureTree(`archive-differs-${doc}`)
      writeFileSync(join(differs, doc), readFileSync(join(differs, doc), 'utf8') + '\n')
      check(`an archive with changed ${doc} is refused`, refused(owner.checkReleaseDocuments({ root: ROOT, archiveDir: differs }), `${doc} differs from the tree's`))
    }
  }

  section('§5 packager and release workflow read the documents')
  {
    const packager = readFileSync(join(ROOT, 'scripts/release/package.mjs'), 'utf8')
    check('the packager imports the documents owner', packager.includes("from './releaseDocuments.mjs'"))
    check('the packager checks before staging and copies all three documents', packager.includes('checkReleaseDocuments({ root: ROOT })') && packager.includes('for (const name of LICENCE_DOCUMENTS) cpSync('))
    check('the packager reads the extracted archive', packager.includes("archiveDir: join(smoke, 'mercury')"))
    check('the release verify job checks the documents before packaging', readFileSync(join(ROOT, '.github/workflows/private-release.yml'), 'utf8').includes('node scripts/release/releaseDocuments.mjs check'))
    check('the archive verifier reads the archive documents', readFileSync(join(ROOT, 'scripts/release/verifyArchive.mjs'), 'utf8').includes('checkReleaseDocuments({ root, archiveDir: payload })'))
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(failures > 0 ? `\nrelease documents: RED (${failures})` : '\nrelease documents: green')
process.exit(failures > 0 ? 1 : 0)
