#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)

const documents = (await import('../release/payloadContract.mjs')) as { DOC_SET: string[]; memberRole: (name: string) => string; topAllowlist: (target: string, floor: unknown) => string[]; readCompatFloor: () => unknown }
const owner = (await import('../release/releaseDocuments.mjs')) as {
  LICENCE_DOCUMENTS: string[]
  LICENCE_FILE: string
  TERMS_FILE: string
  readLicenceParameters: (text: string) => { version: string | null; releaseDate: string | null; releaseTag: string | null; changeDate: string | null; termsSha256: string | null; termsVersion: string | null; placeholders: string[]; reviewBanner: boolean }
  expectedChangeDate: (releaseDate: string) => string | null
  checkReleaseDocuments: (o: { root: string; version: string; today?: string; archiveDir?: string | null }) => { ok: boolean; findings: string[] }
  stampLicence: (licence: string, o: { version: string; releaseDate: string; termsBytes: Buffer }) => string
}

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const refused = (r: { ok: boolean; findings: string[] }, needle: string): boolean => !r.ok && r.findings.some(f => f.includes(needle))
const detailOf = (r: { findings: string[] }): string => r.findings.join(' | ')

console.log('release documents — the licence is read on the release path')

const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const LICENCE = readFileSync(join(ROOT, owner.LICENCE_FILE), 'utf8')
const TERMS = readFileSync(join(ROOT, owner.TERMS_FILE))
const SCRATCH = mkdtempSync(join(tmpdir(), 'release-documents-'))

function fixtureTree(name: string, edit: (licence: string) => string = t => t, opts: { drop?: string[]; terms?: Buffer } = {}): string {
  const dir = join(SCRATCH, name)
  mkdirSync(dir, { recursive: true })
  for (const doc of owner.LICENCE_DOCUMENTS) {
    if (opts.drop?.includes(doc)) continue
    if (doc === owner.LICENCE_FILE) writeFileSync(join(dir, doc), edit(LICENCE))
    else if (doc === owner.TERMS_FILE) writeFileSync(join(dir, doc), opts.terms ?? TERMS)
    else writeFileSync(join(dir, doc), readFileSync(join(ROOT, doc)))
  }
  return dir
}

try {
  section('§1 the tree — LICENSE.md is true for the version root')
  {
    const p = owner.readLicenceParameters(LICENCE)
    check(`the version line names v${VERSION} (the tag being cut)`, p.version === `v${VERSION}`, `licence: ${p.version}`)
    check('the release URL names the same tag', p.releaseTag === `v${VERSION}`, `licence: ${p.releaseTag}`)
    check('the release date is a calendar date', /^\d{4}-\d{2}-\d{2}$/.test(p.releaseDate ?? ''), `licence: ${p.releaseDate}`)
    check('the change date is exactly three years after the release date', p.changeDate !== null && p.changeDate === owner.expectedChangeDate(p.releaseDate ?? ''), `licence: ${p.changeDate}`)
    check('the stated terms SHA-256 equals the terms file', p.termsSha256 === sha256(TERMS), `licence: ${p.termsSha256}`)
    check('no bracketed placeholder, no review banner', p.placeholders.length === 0 && !p.reviewBanner, p.placeholders.join(', '))
    const SDK_DIRS = ['sdk', 'sdk-py']
    const licenceIntro = LICENCE.split('\n## Non-binding plain-English summary')[0] ?? ''
    check(
      'LICENSE.md opens (before the summary) with the CLI (BUSL-1.1 + Community Production Grant) and SDK (Apache-2.0 in sdk/LICENSE and sdk-py/LICENSE) split',
      licenceIntro.includes('This file covers the Mercury CLI under the Business Source License 1.1 (`BUSL-1.1`), with the Mercury Community Production Grant set out in the section of that name below and its companion terms in `MERCURY-COMMUNITY-PRODUCTION-TERMS.md`.') &&
        licenceIntro.includes('The TypeScript and Python SDKs in `sdk/` and `sdk-py/` (`mercury-cli-sdk` on npm and PyPI) are licensed separately under the Apache License 2.0 (`Apache-2.0`) by their own `sdk/LICENSE` and `sdk-py/LICENSE` files, and are not covered by this file.'),
      licenceIntro.slice(-240),
    )
    const scopeLine = /^- \*\*Licensed Work:\*\* .*$/m.exec(LICENCE)?.[0] ?? ''
    check('the Licensed Work line says sdk/ and sdk-py/ are licensed separately under the Apache License 2.0 by their own LICENSE files and are not part of the Licensed Work', SDK_DIRS.every(d => scopeLine.includes(`\`${d}/\``)) && /licensed separately under the Apache License, Version 2\.0, by the LICENSE file each carries, and are not part of the Licensed Work\./.test(scopeLine), scopeLine.slice(-160))
    check('each of those directories carries an Apache License 2.0 LICENSE file (the sentence is true)', SDK_DIRS.every(d => existsSync(join(ROOT, d, 'LICENSE')) && /Apache License\s+Version 2\.0/.test(readFileSync(join(ROOT, d, 'LICENSE'), 'utf8'))))
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    check(
      'README.md top source-available line names both the CLI (Business Source License 1.1) and the SDKs (Apache License 2.0)',
      readme.includes('Mercury is source-available under the Business Source License 1.1, and the SDKs in [sdk/](sdk/) and [sdk-py/](sdk-py/) are licensed under the Apache License 2.0. See [Licence](#licence) for the production-use terms.'),
    )
    const readmeLicence = readme.split('\n## Licence\n\n')[1] ?? ''
    check(
      'README.md Licence section opens with the two-sentence CLI (BUSL-1.1) and SDK (Apache-2.0, linking sdk/LICENSE and sdk-py/LICENSE) split before the summary paragraph',
      readmeLicence.startsWith(
        'The Mercury CLI is licensed under the Business Source License 1.1 (`BUSL-1.1`)\nwith the Mercury Community Production Grant in [LICENSE.md](LICENSE.md). The\nTypeScript and Python SDKs in [sdk/](sdk/) and [sdk-py/](sdk-py/)\n(`mercury-cli-sdk` on npm and PyPI) are licensed separately under the Apache\nLicense 2.0 (`Apache-2.0`), each by the LICENSE file it carries\n([sdk/LICENSE](sdk/LICENSE) and [sdk-py/LICENSE](sdk-py/LICENSE)), and are not\npart of the Licensed Work.\n\nMercury is source-available under the Business Source License 1.1, with the\nMercury Community Production Grant.',
      ),
      readmeLicence.slice(0, 240),
    )
    const sdkLicenceSection = '## Licence\n\nLicensed under the Apache License 2.0 (`Apache-2.0`); see [LICENSE](LICENSE). The Mercury CLI is licensed separately under the Business Source License 1.1 (`BUSL-1.1`).'
    for (const d of SDK_DIRS) {
      const sdkReadme = readFileSync(join(ROOT, d, 'README.md'), 'utf8')
      check(`${d}/README.md carries the one-line Apache-2.0 Licence section linking to LICENSE`, sdkReadme.includes(sdkLicenceSection))
    }
    const sdkPkg = JSON.parse(readFileSync(join(ROOT, 'sdk/package.json'), 'utf8')) as { name?: string; license?: string; files?: string[] }
    const sdkPyproject = readFileSync(join(ROOT, 'sdk-py/pyproject.toml'), 'utf8')
    check(
      'sdk/package.json and sdk-py/pyproject.toml declare Apache-2.0 and ship LICENSE',
      sdkPkg.name === 'mercury-cli-sdk' &&
        sdkPkg.license === 'Apache-2.0' &&
        Array.isArray(sdkPkg.files) &&
        sdkPkg.files.includes('LICENSE') &&
        /^name = "mercury-cli-sdk"$/m.test(sdkPyproject) &&
        /^license = "Apache-2.0"$/m.test(sdkPyproject) &&
        /^license-files = \["LICENSE"\]$/m.test(sdkPyproject),
    )
    for (const doc of owner.LICENCE_DOCUMENTS) check(`${doc} is in the tree`, existsSync(join(ROOT, doc)))
    const tree = owner.checkReleaseDocuments({ root: ROOT, version: VERSION })
    check('the owner passes the tree for the version root', tree.ok, detailOf(tree))
  }

  section('§2 the refusals, each on a fixture')
  {
    const banner = fixtureTree('banner', t => t.replace('\n## Non-binding', '\n> **DRAFT FOR REVIEW**\n\n## Non-binding'))
    check('the review banner is refused', refused(owner.checkReleaseDocuments({ root: banner, version: VERSION }), 'review banner'))
    const hole = fixtureTree('placeholder', t => t.replace(/^- \*\*Version Release Date:\*\* \S+/m, '- **Version Release Date:** `[INSERT YYYY-MM-DD]`'))
    check('a bracketed placeholder is refused', refused(owner.checkReleaseDocuments({ root: hole, version: VERSION }), 'placeholder'))
    const other = fixtureTree('other-version')
    check('a licence naming another version is refused', refused(owner.checkReleaseDocuments({ root: other, version: '9.9.9-beta.9' }), 'names version'))
    const p = owner.readLicenceParameters(LICENCE)
    const flipped = (p.termsSha256 ?? '').replace(/^./, c => (c === 'f' ? '0' : 'f'))
    const hash = fixtureTree('hash', t => t.replace(p.termsSha256 ?? '', flipped))
    check('a terms hash the terms file does not have is refused', refused(owner.checkReleaseDocuments({ root: hash, version: VERSION }), 'SHA-256'))
    const changed = fixtureTree('terms-changed', t => t, { terms: Buffer.concat([TERMS, Buffer.from('\nan amendment\n')]) })
    check('changed terms bytes behind an unchanged hash are refused', refused(owner.checkReleaseDocuments({ root: changed, version: VERSION }), 'SHA-256'))
    const change = fixtureTree('change-date', t => t.replace(/^- \*\*Change Date:\*\* \S+/m, '- **Change Date:** 2030-01-01'))
    check('a change date not three years on is refused', refused(owner.checkReleaseDocuments({ root: change, version: VERSION }), 'change date'))
    const future = fixtureTree('future', t => t.replace(/^- \*\*Version Release Date:\*\* \S+/m, '- **Version Release Date:** 2099-01-01'))
    check('a release date after today is refused', refused(owner.checkReleaseDocuments({ root: future, version: VERSION }), 'after today'))
    const noTerms = fixtureTree('no-terms', t => t, { drop: [owner.TERMS_FILE] })
    check('a missing terms file is refused', refused(owner.checkReleaseDocuments({ root: noTerms, version: VERSION }), 'missing'))
    const noMarks = fixtureTree('no-trademarks', t => t, { drop: ['TRADEMARKS.md'] })
    check('a missing TRADEMARKS.md is refused', refused(owner.checkReleaseDocuments({ root: noMarks, version: VERSION }), 'TRADEMARKS.md is missing'))
  }

  section('§3 the stamp — fills the draft shape, idempotent, only the parameter lines')
  {
    const draft = LICENCE
      .replace(/^- \*\*Version:\*\* `[^`]*`/m, '- **Version:** `[INSERT VERSION OR RELEASE TAG]`')
      .replace(/^- \*\*Version Release Date:\*\* \S+ \(published at \S+\)/m, '- **Version Release Date:** [INSERT YYYY-MM-DD] (published at https://github.com/Whq02/MercuryCLI/releases/tag/vX)')
      .replace(/^- \*\*Change Date:\*\* \S+/m, '- **Change Date:** [INSERT YYYY-MM-DD]')
      .replace(/SHA-256 `[^`]*`/, 'SHA-256 `[INSERT HASH]`')
    const stamped = owner.stampLicence(draft, { version: '2.0.0-beta.1', releaseDate: '2027-03-31', termsBytes: TERMS })
    const p = owner.readLicenceParameters(stamped)
    check('the stamp fills the version and the tag URL', p.version === 'v2.0.0-beta.1' && p.releaseTag === 'v2.0.0-beta.1', `${p.version} / ${p.releaseTag}`)
    check('the stamp fills the release date and the change date three years on', p.releaseDate === '2027-03-31' && p.changeDate === '2030-03-31', `${p.releaseDate} / ${p.changeDate}`)
    check('the stamp fills the terms hash and version from the terms bytes', p.termsSha256 === sha256(TERMS) && p.termsVersion === '1')
    check('the stamp is idempotent', owner.stampLicence(stamped, { version: '2.0.0-beta.1', releaseDate: '2027-03-31', termsBytes: TERMS }) === stamped)
    const draftLines = draft.split('\n')
    const changedLines = stamped.split('\n').filter((l, i) => l !== draftLines[i])
    check('the stamp touches only the four parameter lines', changedLines.length === 4 && changedLines.every(l => /^- \*\*(Version|Version Release Date|Change Date|Companion Production Terms):\*\*/.test(l)), changedLines.join(' | '))
    const dir = fixtureTree('stamped', () => stamped)
    const r = owner.checkReleaseDocuments({ root: dir, version: '2.0.0-beta.1', today: '2027-04-01' })
    check('the stamped licence passes the check for its version', r.ok, detailOf(r))
    check('a leap day lands on the last day of February three years on', owner.expectedChangeDate('2028-02-29') === '2031-02-28')
    const back = owner.stampLicence(stamped, { version: VERSION, releaseDate: owner.readLicenceParameters(LICENCE).releaseDate ?? '', termsBytes: TERMS })
    check('stamping back to the tree values reproduces the tree licence byte for byte', back === LICENCE)
  }

  section('§4 the archive contract — the document set and the packaged dir')
  {
    for (const doc of owner.LICENCE_DOCUMENTS) {
      check(`${doc} is a doc member of the payload contract`, documents.DOC_SET.includes(doc) && documents.memberRole(doc) === 'doc')
    }
    const floor = documents.readCompatFloor()
    check('both platform allowlists carry the three documents', ['linux-x64', 'windows-x64'].every(t => owner.LICENCE_DOCUMENTS.every(d => documents.topAllowlist(t, floor).includes(d))))
    const archive = fixtureTree('archive')
    const good = owner.checkReleaseDocuments({ root: ROOT, version: VERSION, archiveDir: archive })
    check('a payload dir carrying the three documents verbatim passes', good.ok, detailOf(good))
    const missing = fixtureTree('archive-missing', t => t, { drop: ['TRADEMARKS.md'] })
    check('a payload dir missing TRADEMARKS.md is refused', refused(owner.checkReleaseDocuments({ root: ROOT, version: VERSION, archiveDir: missing }), 'missing TRADEMARKS.md'))
    const differs = fixtureTree('archive-differs', t => t, { terms: Buffer.concat([TERMS, Buffer.from('\n')]) })
    const r = owner.checkReleaseDocuments({ root: ROOT, version: VERSION, archiveDir: differs })
    check('a payload dir whose terms bytes differ is refused (bytes and hash)', refused(r, 'differs from the tree') && refused(r, 'hashes to'), detailOf(r))
  }

  section('§5 the wiring — packager and release workflow read the documents')
  {
    const packager = readFileSync(join(ROOT, 'scripts/release/package.mjs'), 'utf8')
    check('the packager imports the documents owner', packager.includes("from './releaseDocuments.mjs'"))
    check('the packager checks the documents before staging and copies all three', packager.includes('checkReleaseDocuments({ root: ROOT, version: VERSION })') && packager.includes('for (const name of LICENCE_DOCUMENTS) cpSync('))
    check('the packager reads the documents back out of the extracted archive', packager.includes("archiveDir: join(smoke, 'mercury')"))
    const workflow = readFileSync(join(ROOT, '.github/workflows/private-release.yml'), 'utf8')
    check('the release verify job checks the documents for the tag before packaging', workflow.includes('node scripts/release/releaseDocuments.mjs check --version "${TAG#v}"'))
    check('the archive verifier reads the documents from the archive', readFileSync(join(ROOT, 'scripts/release/verifyArchive.mjs'), 'utf8').includes('checkReleaseDocuments({ root, version, archiveDir: payload })'))
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\nrelease documents: RED (${failures})`)
  process.exit(1)
}
console.log('\nrelease documents: green')
