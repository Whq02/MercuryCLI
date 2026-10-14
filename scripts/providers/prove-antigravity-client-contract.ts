#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { statSync } from 'node:fs'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

type Capture = { path: string; method: string; headers: Record<string, string> }
const requests: Capture[] = []
const manifest = { version: '0.0.0', status: 200, body: undefined as string | undefined, hold: undefined as Promise<void> | undefined }
const manifestText = (version: string): string => [`version: ${version}`, 'files:', `  - url: https://storage.example.invalid/antigravity-hub/${version}/darwin-arm/Antigravity.zip`, '    sha512: fixture', '    size: 1', 'path: Antigravity.zip', 'sha512: fixture', ''].join('\n')
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    requests.push({ path: url.pathname, method: req.method, headers: Object.fromEntries(req.headers.entries()) })
    if (manifest.hold) await manifest.hold
    if (url.pathname !== '/manifest/latest-arm64-mac.yml') return new Response('not found', { status: 404 })
    if (manifest.status !== 200) return new Response('fixture fault', { status: manifest.status })
    return new Response(manifest.body ?? manifestText(manifest.version), { headers: { 'content-type': 'text/yaml' } })
  },
})
const base = `http://127.0.0.1:${server.port}`
process.env.MERCURY_ANTIGRAVITY_MANIFEST_BASE = base

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const contract = await import('../../src/services/providers/gemini/antigravityClientContract.ts')
const DAY = 24 * 60 * 60 * 1000
let clock = Date.UTC(2026, 9, 14, 12, 0, 0)
const now = (): number => clock
const CONSTANT = contract.ANTIGRAVITY_CLIENT_CONTRACT_VERSION
const bump = (version: string, delta: number): string => version.replace(/\d+$/, patch => String(Number(patch) + delta))
const olderThan = (version: string): string => { const [major, minor, patch] = version.split('.').map(Number) as [number, number, number]; return patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.9` : `${major - 1}.9.9` }
manifest.version = CONSTANT

try {
  console.log('── the shipped constants: the client, the scopes, the version and its check date ──')
  check('the client id is the Antigravity client, the secret its installed-app secret, the scopes the five Antigravity scopes', /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(contract.ANTIGRAVITY_OAUTH_CLIENT_ID) && /^GOCSPX-/.test(contract.ANTIGRAVITY_OAUTH_CLIENT_SECRET) && contract.ANTIGRAVITY_OAUTH_SCOPE.split(' ').length === 5 && ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].every(s => contract.ANTIGRAVITY_OAUTH_SCOPE.includes(`https://www.googleapis.com/auth/${s}`)))
  check('the version constant is three-part and dated; the changelist is digits', /^\d+\.\d+\.\d+$/.test(CONSTANT) && /^\d{4}-\d{2}-\d{2}$/.test(contract.ANTIGRAVITY_CLIENT_CONTRACT_AS_OF) && /^\d+$/.test(contract.ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST))
  const constant = contract.presentedAntigravityClient()
  check('with no record the constant presents', constant.source === 'constant' && constant.version === CONSTANT && constant.asOf === contract.ANTIGRAVITY_CLIENT_CONTRACT_AS_OF)
  check('the User-Agent is the Antigravity client\'s own shape', contract.antigravityUserAgent() === `antigravity/hub/${CONSTANT} (aidev_client; os_type=darwin; arch=arm64; cl=${contract.ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST})`, contract.antigravityUserAgent())
  check('the record lives beside the credential in the auth-scoped home', contract.antigravityClientContractPath().startsWith(proofHome) && contract.antigravityClientContractPath().endsWith('.antigravity-client-contract.json'))
  check('the manifest road is the arm64 mac manifest under one base, the production base being Antigravity\'s own update host', contract.antigravityManifestUrl() === `${base}/manifest/latest-arm64-mac.yml` && contract.ANTIGRAVITY_MANIFEST_DEFAULT_BASE === 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app')

  console.log('── the manifest decoder: the version line alone, quoted or bare, never a comment or a non-version ──')
  check('a bare version line decodes', contract.decodeAntigravityManifestVersion(manifestText('2.30.1')) === '2.30.1')
  check('a quoted version line decodes', contract.decodeAntigravityManifestVersion('version: "2.30.2"\nfiles: []\n') === '2.30.2' && contract.decodeAntigravityManifestVersion("version: '2.30.3' # note\n") === '2.30.3')
  check('a non-three-part version, a missing line and a commented line decode to nothing', contract.decodeAntigravityManifestVersion('version: 2.30\n') === undefined && contract.decodeAntigravityManifestVersion('files: []\n') === undefined && contract.decodeAntigravityManifestVersion('# version: 2.30.4\n') === undefined)

  console.log('── the manifest answers the same version: nothing learned, the peek stamped ──')
  const same = await contract.peekAntigravityClient({ now, force: true })
  check('a read of the current version learns nothing and the constant still presents', same.kind === 'read' && same.answer.ok && same.answer.version === CONSTANT && !same.learned && contract.presentedAntigravityClient().source === 'constant', JSON.stringify(same))
  const reads = requests.filter(r => r.path === '/manifest/latest-arm64-mac.yml')
  check('the read was one bounded GET as an update client, no credential', reads.length === 1 && reads[0]!.method === 'GET' && reads[0]!.headers['user-agent'] === 'electron-builder' && reads[0]!.headers.authorization === undefined, JSON.stringify(reads[0]?.headers))
  check('the daily peek holds within the day', (await contract.peekAntigravityClient({ now })).kind === 'skipped' && requests.filter(r => r.path === '/manifest/latest-arm64-mac.yml').length === 1)
  check('the record is mode 600 and carries the peek stamp', (statSync(contract.antigravityClientContractPath()).mode & 0o777) === 0o600 && contract.readAntigravityClientRecord().lastPeekAtMs === clock)

  console.log('── the manifest answers a NEWER version: learned, stored, presented in the User-Agent ──')
  manifest.version = bump(CONSTANT, 7)
  clock += DAY
  const newer = await contract.peekAntigravityClient({ now })
  check('a newer version is learned', newer.kind === 'read' && newer.answer.ok && newer.learned && newer.answer.version === bump(CONSTANT, 7), JSON.stringify(newer))
  const learned = contract.presentedAntigravityClient()
  check('the learned version presents over the constant, dated by its own learning', learned.source === 'learned' && learned.version === bump(CONSTANT, 7) && learned.asOf === '2026-10-15' && learned.changelist === contract.ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST, JSON.stringify(learned))
  check('the User-Agent carries the learned version', contract.antigravityUserAgent() === `antigravity/hub/${bump(CONSTANT, 7)} (aidev_client; os_type=darwin; arch=arm64; cl=${contract.ANTIGRAVITY_CLIENT_CONTRACT_CHANGELIST})`)
  check('the constant is untouched while the learned version presents', contract.ANTIGRAVITY_CLIENT_CONTRACT_VERSION === CONSTANT)
  const record = contract.readAntigravityClientRecord()
  check('the record carries the learned version with its stamp and source', record.learned?.version === bump(CONSTANT, 7) && record.learned.learnedAtMs === clock && record.learned.from === `${base}/manifest/latest-arm64-mac.yml` && record.lastFailure === undefined, JSON.stringify(record))

  console.log('── the manifest answers an OLDER version: the stored newest is kept ──')
  manifest.version = olderThan(CONSTANT)
  clock += DAY
  const older = await contract.peekAntigravityClient({ now })
  check('an older version is read but never presented', older.kind === 'read' && older.answer.ok && !older.learned && contract.presentedAntigravityClient().version === bump(CONSTANT, 7), JSON.stringify(older))

  console.log('── the manifest is unreachable or malformed: the stored version stands, the failure noted ──')
  manifest.status = 503
  clock += DAY
  const down = await contract.peekAntigravityClient({ now })
  check('a failed read keeps the stored version and records the failure words', down.kind === 'read' && !down.answer.ok && down.answer.words.includes('HTTP 503') && contract.presentedAntigravityClient().version === bump(CONSTANT, 7) && contract.readAntigravityClientRecord().lastFailure?.words.includes('HTTP 503') === true, JSON.stringify(down))
  check('the words name the failure beside the presented version', contract.antigravityClientContractWords().includes(bump(CONSTANT, 7)) && contract.antigravityClientContractWords().includes('HTTP 503'))
  manifest.status = 200
  manifest.body = 'files: []\n'
  clock += DAY
  const malformed = await contract.peekAntigravityClient({ now })
  check('a manifest without a version line is a named failure', malformed.kind === 'read' && !malformed.answer.ok && malformed.answer.words.includes('named no three-part version'), JSON.stringify(malformed))
  manifest.body = 'version: 9.9.9\n'.padEnd(70 * 1024, '#')
  clock += DAY
  const oversized = await contract.peekAntigravityClient({ now })
  check('an oversized manifest is refused by size, never read whole', oversized.kind === 'read' && !oversized.answer.ok && oversized.answer.words.includes('ran past 64 KiB') && contract.presentedAntigravityClient().version === bump(CONSTANT, 7), JSON.stringify(oversized))
  manifest.body = undefined
  manifest.version = bump(CONSTANT, 7)
  clock += DAY
  const healed = await contract.peekAntigravityClient({ now })
  check('a later good read clears the failure note', healed.kind === 'read' && healed.answer.ok && contract.readAntigravityClientRecord().lastFailure === undefined)

  console.log('── the deadline: a stalled manifest host ends the read within its bound ──')
  let release!: () => void
  manifest.hold = new Promise<void>(resolve => { release = resolve })
  const started = Date.now()
  const stalled = await contract.peekAntigravityClient({ now, force: true })
  const waited = Date.now() - started
  release()
  manifest.hold = undefined
  check('a stalled host is a timeout within the deadline, the stored version kept', stalled.kind === 'read' && !stalled.answer.ok && stalled.answer.words.includes('timeout after 5 s') && waited < contract.ANTIGRAVITY_MANIFEST_DEADLINE_MS + 2000 && contract.presentedAntigravityClient().version === bump(CONSTANT, 7), `${JSON.stringify(stalled)} after ${waited} ms`)

  console.log('── the doors that keep the peek quiet: traffic-off, the proof shape off the box, the same day ──')
  const countBefore = requests.length
  const quiet = await contract.peekAntigravityClient({ now, env: { ...process.env, MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  check('traffic-off skips the peek without a request', quiet.kind === 'skipped' && quiet.why === 'traffic-off' && requests.length === countBefore)
  const offBox = await contract.peekAntigravityClient({ now, env: { ...process.env, MERCURY_ANTIGRAVITY_MANIFEST_BASE: 'https://example.invalid' }, force: true })
  check('the proof shape skips a host off the box', offBox.kind === 'skipped' && offBox.why === 'proof-shape' && requests.length === countBefore)
  const offBoxRead = await contract.readAntigravityVersionFromManifest({ env: { ...process.env, MERCURY_ANTIGRAVITY_MANIFEST_BASE: 'https://example.invalid' } })
  check('the bounded read itself refuses a host off the box under the proof shape', !offBoxRead.ok && offBoxRead.words.includes('MERCURY_LOCAL_PROBE_TARGETS'))
  check('a peek within the day is skipped as today', (await contract.peekAntigravityClient({ now })).kind === 'skipped' && requests.length === countBefore)
} finally {
  server.stop(true)
}
console.log(`\n${passes} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
