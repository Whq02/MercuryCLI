#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mercury-samples-store-'))
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_SAMPLES

const store = await import('../../src/services/samples/store.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

const SESSION = 'sess-store'

section('S1 a name makes a sample; the same name appends a version')
const a = store.createOrAppendSample({ sessionId: SESSION, name: 'Landing Page', html: '<h1>alpha-one</h1>' })
check(
  'S1a the first call makes version 1: the slug, the title, the open state, the glyph',
  a.version === 1 &&
    a.record.slug === 'landing-page' &&
    a.record.title === 'Landing Page' &&
    a.record.state === 'open' &&
    a.record.latestVersion === 1 &&
    a.record.versions.length === 1 &&
    a.record.versions[0]!.n === 1 &&
    a.record.glyph === '⧉' &&
    a.record.sessionId === SESSION,
  JSON.stringify(a.record),
)
check('S1b the id is short, lower-case and one path segment', /^[a-z0-9]{6,32}$/.test(a.record.id))
const b = store.createOrAppendSample({ sessionId: SESSION, name: 'landing page', title: 'Landing', html: '<h1>alpha-two</h1>' })
check(
  'S1c the same name, spelt differently, appends version 2 of the SAME sample',
  b.record.id === a.record.id && b.version === 2 && b.record.latestVersion === 2,
  JSON.stringify(b.record),
)
check('S1d the title follows the call that gave one', b.record.title === 'Landing')
check(
  'S1e updatedAt moved with latestVersion and createdAt stayed',
  b.record.updatedAt > a.record.updatedAt && b.record.createdAt === a.record.createdAt,
  `${a.record.updatedAt} → ${b.record.updatedAt}`,
)
check('S1f the versions list carries both, in order, each with its own stamp', b.record.versions.map(v => v.n).join(',') === '1,2' && b.record.versions[1]!.createdAt === b.record.updatedAt)
check('S1g one sample in the session, not two', store.listSamples(SESSION).length === 1)
const c = store.createOrAppendSample({ sessionId: SESSION, name: 'Landing page', html: '<h1>alpha-three</h1>' })
check('S1h a call without a title keeps the title', c.record.title === 'Landing' && c.version === 3)
check(
  'S1i slugs: punctuation folds to dashes, nothing usable becomes "sample"',
  store.slugOf('  Hello, World!! ') === 'hello-world' && store.slugOf('***') === 'sample' && store.slugOf('Q3 Report (draft)') === 'q3-report-draft',
  [store.slugOf('  Hello, World!! '), store.slugOf('***'), store.slugOf('Q3 Report (draft)')].join(' · '),
)

section('S2 versions are kept as written')
const id = a.record.id
const dir = store.sampleDir(SESSION, id)
check('S2a v1 reads back byte for byte', store.readVersion(SESSION, id, 1) === '<h1>alpha-one</h1>')
check('S2b v2 and v3 read back', store.readVersion(SESSION, id, 2) === '<h1>alpha-two</h1>' && store.readVersion(SESSION, id, 3) === '<h1>alpha-three</h1>')
check('S2c a version that does not exist is null', store.readVersion(SESSION, id, 4) === null && store.readVersion(SESSION, id, 0) === null)
check(
  'S2d the files sit under sessions/<session>/samples/<id> in the config home',
  dir.startsWith(process.env.MERCURY_CONFIG_DIR!) &&
    dir.includes(join('sessions', SESSION, 'samples', id)) &&
    existsSync(join(dir, 'v1.html')) &&
    existsSync(join(dir, 'v3.html')) &&
    existsSync(join(dir, 'sample.json')),
  dir,
)
check('S2e getSample reads the record the list reads', JSON.stringify(store.getSample(SESSION, id)) === JSON.stringify(c.record) && JSON.stringify(store.listSamples(SESSION)[0]) === JSON.stringify(c.record))
check('S2f the record on disk is the record in hand', JSON.stringify(JSON.parse(readFileSync(join(dir, 'sample.json'), 'utf8'))) === JSON.stringify(c.record))

section('S3 newest first; a torn write never shows')
const d = store.createOrAppendSample({ sessionId: SESSION, name: 'Quarterly report', html: '<p>report</p>' })
const listed = store.listSamples(SESSION)
check('S3a the newer sample lists first', listed.length === 2 && listed[0]!.id === d.record.id && listed[1]!.id === id, listed.map(r => r.slug).join(','))
store.createOrAppendSample({ sessionId: SESSION, name: 'landing-page', html: '<h1>alpha-four</h1>' })
check('S3b a new version moves its sample to the top', store.listSamples(SESSION)[0]!.id === id)
writeFileSync(join(dir, 'sample.json.tmp-1-1'), '{"id": "', 'utf8')
const tornDir = join(store.samplesRoot(SESSION), 'deadbeef00')
mkdirSync(tornDir, { recursive: true })
writeFileSync(join(tornDir, 'sample.json'), '{"id": "deadbeef00", "slug": "torn', 'utf8')
const afterTorn = store.listSamples(SESSION)
check(
  'S3c a temp sibling and a half-written record are invisible; the intact records still list',
  afterTorn.length === 2 && afterTorn.every(r => r.id !== 'deadbeef00') && store.getSample(SESSION, 'deadbeef00') === null,
  afterTorn.map(r => r.id).join(','),
)
mkdirSync(join(store.samplesRoot(SESSION), 'NOT-an-id'), { recursive: true })
writeFileSync(join(store.samplesRoot(SESSION), 'stray.json'), '{}', 'utf8')
check('S3d a foreign entry under samples/ is ignored', store.listSamples(SESSION).length === 2)
check(
  'S3e no publish leaves a temp sibling of its own behind',
  readdirSync(dir).filter(n => n.includes('.tmp-')).join(',') === 'sample.json.tmp-1-1',
  readdirSync(dir).join(','),
)
check('S3f a session with no samples lists nothing', store.listSamples('sess-empty').length === 0)
check('S3g a record whose id disagrees with its directory is refused', (() => {
  const liar = join(store.samplesRoot(SESSION), 'cafe000001')
  mkdirSync(liar, { recursive: true })
  writeFileSync(join(liar, 'sample.json'), JSON.stringify({ ...c.record, id: 'someoneelse' }), 'utf8')
  return store.getSample(SESSION, 'cafe000001') === null && store.listSamples(SESSION).length === 2
})())

section('S4 marks append per version; the verdict moves the state')
const updatedBefore = store.getSample(SESSION, id)!.updatedAt
const m1 = store.appendMarks(SESSION, id, { version: 4, pins: [{ x: 0.5, y: 0.25, target: 'h1', text: 'bigger' }], note: '', verdict: 'changes-needed' })
check('S4a the first marks land and the state moves to changes-needed', m1.count === 1 && m1.record.state === 'changes-needed', JSON.stringify(m1))
const m2 = store.appendMarks(SESSION, id, { version: 4, pins: [], note: 'looks right now', verdict: null })
check('S4b marks without a verdict append and leave the state', m2.count === 2 && m2.record.state === 'changes-needed')
const m3 = store.appendMarks(SESSION, id, { version: 4, pins: [], note: '', verdict: 'approve' })
check('S4c an approve moves the state to approved, on disk too', m3.record.state === 'approved' && store.getSample(SESSION, id)!.state === 'approved')
const marksFile = JSON.parse(readFileSync(join(dir, 'marks-v4.json'), 'utf8')) as Array<{ pins: Array<{ text: string }>; note: string }>
check('S4d marks-v4.json holds the three in order', Array.isArray(marksFile) && marksFile.length === 3 && marksFile[0]!.pins[0]!.text === 'bigger' && marksFile[1]!.note === 'looks right now')
check('S4e readMarks reads the same; an unmarked version has none', store.readMarks(SESSION, id, 4).length === 3 && store.readMarks(SESSION, id, 1).length === 0)
check('S4f marks on a version that does not exist are refused and write nothing', throws(() => store.appendMarks(SESSION, id, { version: 9, pins: [], note: '', verdict: null })) && !existsSync(join(dir, 'marks-v9.json')))
check('S4g marks on a sample that does not exist are refused', throws(() => store.appendMarks(SESSION, 'abcdef0000', { version: 1, pins: [], note: '', verdict: null })))
check('S4h marks never move updatedAt', store.getSample(SESSION, id)!.updatedAt === updatedBefore)
const e = store.createOrAppendSample({ sessionId: SESSION, name: 'landing page', html: '<h1>alpha-five</h1>' })
check('S4i a new version opens the sample again', e.record.state === 'open' && e.version === 5 && e.record.updatedAt > updatedBefore)

section('S5 the address: the file page with no listener, the listener when bound')
check('S5a an unknown id has no address', store.sampleUrl('unknown00') === null)
check('S5b before the page is written and with no listener there is no address', store.sampleUrl(id) === null)
const page = store.writeFallbackPage(SESSION, id)
check('S5c the self-contained page sits beside the latest version', page !== null && page.endsWith('v5.page.html') && existsSync(page), String(page))
const pageText = readFileSync(page!, 'utf8')
check(
  'S5d it carries every version inline and names the sample and its version',
  ['alpha-one', 'alpha-two', 'alpha-three', 'alpha-four', 'alpha-five'].every(w => pageText.includes(w)) && pageText.includes('Landing') && pageText.includes('version 5'),
)
check('S5e it loads nothing from the network', !/https?:\/\//.test(pageText))
check('S5f the model\'s markup is inert in the shell: it rides escaped inside srcdoc', !pageText.includes('<h1>alpha-one</h1>') && pageText.includes('&lt;h1&gt;alpha-one&lt;/h1&gt;'))
const url = store.sampleUrl(id)
check('S5g sampleUrl answers the page as a file address', url !== null && url.startsWith('file://') && url.endsWith('v5.page.html'), String(url))
check('S5h writing the page for a sample that does not exist answers null', store.writeFallbackPage(SESSION, 'abcdef0000') === null)
store.setSampleListenerAddress({ port: 4242, token: 'a'.repeat(32) })
check('S5i with a listener bound, sampleUrl answers the loopback address with the token', store.sampleUrl(id) === `http://127.0.0.1:4242/s/${id}?t=${'a'.repeat(32)}`, String(store.sampleUrl(id)))
store.setSampleListenerAddress(null)
check('S5j and the file address again once it is gone', store.sampleUrl(id) === url)
check('S5k sessionOfSample knows every id this process wrote or read', store.sessionOfSample(id) === SESSION && store.sessionOfSample(d.record.id) === SESSION && store.sessionOfSample('unknown00') === null)

section('P the poison — the predicates bite')
check('P1 the version reader tells versions apart', store.readVersion(SESSION, id, 1) !== store.readVersion(SESSION, id, 2))
check('P2 a spoiled record is refused while its intact sibling answers', store.getSample(SESSION, 'deadbeef00') === null && store.getSample(SESSION, id) !== null)
check('P3 a spoiled session id is refused before any path is built', throws(() => store.samplesRoot('../escape')) && throws(() => store.createOrAppendSample({ sessionId: 'a/b', name: 'x', html: '<p>x</p>' })))
check('P4 a spoiled sample id is refused before any path is built', throws(() => store.sampleDir(SESSION, '../x')) && store.getSample(SESSION, '../x') === null && store.readVersion(SESSION, '../x', 1) === null)
check('P5 the page comparator bites: a page without a version is not the page', pageText !== pageText.replace('alpha-three', ''))

console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ samples store: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ samples store: every law holds')
process.exit(0)
