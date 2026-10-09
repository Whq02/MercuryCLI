#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { nousFixture, NOUS_FIXTURE_CLIENT_ID, NOUS_FIXTURE_SCOPE } from './lib/nous-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.NOUS_API_KEY
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
const fixture = nousFixture()
Object.assign(process.env, fixture.signinEnv)

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const contract = await import('../../src/services/providers/nous/nousClientContract.ts')
const oauth = await import('../../src/services/providers/nous/nousOauth.ts')
const login = await import('../../src/services/providers/nous/nousLogin.ts')
const DAY = 24 * 60 * 60 * 1000
let clock = Date.UTC(2026, 9, 9, 12, 0, 0)
const now = (): number => clock

try {
  console.log('── the shipped constant: the presented client facts and their check date ──')
  check('the constant presents the Portal client id and the invoke scope as of a dated release', contract.NOUS_PORTAL_CLIENT_ID === NOUS_FIXTURE_CLIENT_ID && contract.NOUS_PORTAL_SIGNIN_SCOPE === NOUS_FIXTURE_SCOPE && /^\d+\.\d+\.\d+$/.test(contract.NOUS_CLIENT_CONTRACT_RELEASE) && /^\d{4}-\d{2}-\d{2}$/.test(contract.NOUS_CLIENT_CONTRACT_AS_OF))
  const constant = contract.presentedNousClient()
  check('with no record the constant presents', constant.source === 'constant' && constant.clientId === contract.NOUS_PORTAL_CLIENT_ID && constant.release === contract.NOUS_CLIENT_CONTRACT_RELEASE && constant.asOf === contract.NOUS_CLIENT_CONTRACT_AS_OF)
  check('the record lives beside the credential in the auth-scoped home', contract.nousClientContractPath().startsWith(proofHome) && contract.nousClientContractPath().endsWith('.nous-client-contract.json') && oauth.nousAuthPathForDisplay().startsWith(proofHome))
  check('the source road is the release list and the contents road under one base, the production base being the public code host', contract.nousClientReleaseUrl().startsWith(`${fixture.base}/repos/NousResearch/hermes-agent/releases/latest`) && contract.nousClientSourceUrl('v9.9.9').includes('/contents/hermes_cli/auth_constants.py?ref=v9.9.9') && contract.NOUS_CLIENT_SOURCE_DEFAULT_BASE === 'https://api.github.com')

  console.log('── the source answers the same release: nothing learned, the peek stamped ──')
  const same = await contract.peekNousClient({ now, force: true })
  check('a read of the current release learns nothing and the constant still presents', same.kind === 'read' && same.answer.ok && same.answer.facts.release === contract.NOUS_CLIENT_CONTRACT_RELEASE && !same.learned && contract.presentedNousClient().source === 'constant', JSON.stringify(same))
  const sourceReads = fixture.requests.filter(r => r.path.startsWith('/repos/')).length
  check('the read was two bounded GETs under Mercury\'s own user agent, no credential', sourceReads === 2 && fixture.requests.filter(r => r.path.startsWith('/repos/')).every(r => r.method === 'GET' && /^mercury\//.test(r.headers['user-agent'] ?? '') && r.headers.authorization === undefined))
  check('the daily peek holds within the day', (await contract.peekNousClient({ now })).kind === 'skipped' && fixture.requests.filter(r => r.path.startsWith('/repos/')).length === sourceReads)
  check('the record is mode 600 and carries the peek stamp', (statSync(contract.nousClientContractPath()).mode & 0o777) === 0o600 && contract.readNousClientRecord().lastPeekAtMs === clock)

  console.log('── the source answers a NEWER release with moved facts: learned, stored, presented, sent ──')
  fixture.source.tag = 'v0.22.0'
  fixture.source.clientId = 'hermes-cli-next'
  fixture.source.scope = 'inference:invoke billing:read'
  fixture.oauth.clientIds.add('hermes-cli-next')
  clock += DAY
  const newer = await contract.peekNousClient({ now })
  check('a newer release is learned', newer.kind === 'read' && newer.answer.ok && newer.learned && newer.answer.facts.clientId === 'hermes-cli-next' && newer.answer.facts.release === '0.22.0', JSON.stringify(newer))
  const learned = contract.presentedNousClient()
  check('the learned facts present over the constant, dated by their own learning', learned.source === 'learned' && learned.clientId === 'hermes-cli-next' && learned.scope === 'inference:invoke billing:read' && learned.release === '0.22.0' && learned.asOf === '2026-10-10', JSON.stringify(learned))
  check('the constant is untouched while the learned facts present', contract.NOUS_PORTAL_CLIENT_ID === NOUS_FIXTURE_CLIENT_ID && contract.NOUS_CLIENT_CONTRACT_RELEASE !== '0.22.0')
  const record = contract.readNousClientRecord()
  check('the record carries the learned facts with their stamp and source', record.learned?.clientId === 'hermes-cli-next' && record.learned.learnedAtMs === clock && record.learned.from.includes('/contents/hermes_cli/auth_constants.py?ref=v0.22.0') && record.lastFailure === undefined, JSON.stringify(record))
  const startBefore = fixture.requests.length
  const start = await oauth.startNousDeviceAuth({ now })
  const startReq = fixture.requests.slice(startBefore).find(r => r.path === '/api/oauth/device/code')
  check('the START request presents the learned client id and scope', startReq?.body?.client_id === 'hermes-cli-next' && startReq.body?.scope === 'inference:invoke billing:read' && start.clientId === 'hermes-cli-next', JSON.stringify(startReq?.body))

  console.log('── the source answers an OLDER release: the stored newest is kept ──')
  fixture.source.tag = 'v0.21.0'
  fixture.source.clientId = 'hermes-cli-old'
  clock += DAY
  const older = await contract.peekNousClient({ now })
  check('an older release is read but never presented', older.kind === 'read' && older.answer.ok && !older.learned && contract.presentedNousClient().clientId === 'hermes-cli-next', JSON.stringify(older))

  console.log('── the source is unreachable: the stored facts stand, the failure noted, the sign-in door still opens ──')
  fixture.source.releaseStatus = 503
  clock += DAY
  const down = await contract.peekNousClient({ now })
  check('a failed read keeps the stored facts and records the failure words', down.kind === 'read' && !down.answer.ok && down.answer.words.includes('HTTP 503') && contract.presentedNousClient().clientId === 'hermes-cli-next' && contract.readNousClientRecord().lastFailure?.words.includes('HTTP 503') === true, JSON.stringify(down))
  check('the words name the failure beside the presented facts', contract.nousClientContractWords().includes('hermes-cli-next') && contract.nousClientContractWords().includes('HTTP 503'))
  fixture.source.releaseStatus = 200
  fixture.source.contentsStatus = 404
  clock += DAY
  const noFile = await contract.peekNousClient({ now })
  check('a release whose source file is missing keeps the stored facts', noFile.kind === 'read' && !noFile.answer.ok && noFile.answer.words.includes("the release's source: HTTP 404") && contract.presentedNousClient().clientId === 'hermes-cli-next', JSON.stringify(noFile))
  fixture.source.contentsStatus = 200
  const savedBase = process.env.MERCURY_NOUS_CLIENT_SOURCE_BASE
  process.env.MERCURY_NOUS_CLIENT_SOURCE_BASE = 'http://127.0.0.1:1'
  clock += DAY
  const t0 = Date.now()
  const unreachable = await contract.peekNousClient({ now })
  check('an unreachable source answers within the deadline and keeps the stored facts', unreachable.kind === 'read' && !unreachable.answer.ok && unreachable.answer.words.startsWith('the release list: no network') && Date.now() - t0 < contract.NOUS_CLIENT_SOURCE_DEADLINE_MS + 1_000 && contract.presentedNousClient().clientId === 'hermes-cli-next', JSON.stringify(unreachable))
  const doorBefore = fixture.requests.length
  const outcome = await login.runNousDeviceLogin({ io: { now }, sleep: ms => sleep(Math.min(ms, 20)) })
  check('the sign-in door opens while the source is unreachable, presenting the stored facts', outcome.ok && fixture.requests.slice(doorBefore).find(r => r.path === '/api/oauth/device/code')?.body?.client_id === 'hermes-cli-next', outcome.receipt)
  process.env.MERCURY_NOUS_CLIENT_SOURCE_BASE = savedBase

  console.log('── the answer shapes the learner refuses ──')
  check('a tag that is not a three-part release is refused', contract.releaseOfTag('latest') === undefined && contract.releaseOfTag('v2026.9.24') === '2026.9.24' && contract.releaseOfTag('v0.21.6') === '0.21.6')
  check('a source text without the two constants decodes nothing', contract.decodeNousClientFacts('DEFAULT_NOUS_CLIENT_ID = 1\n', '0.1.0') === undefined && contract.decodeNousClientFacts('DEFAULT_NOUS_CLIENT_ID = "x"\nNOUS_INFERENCE_INVOKE_SCOPE = "y"\n', '0.1.0')?.clientId === 'x')
  check('a record of the wrong shape reads empty', JSON.stringify(contract.decodeNousClientRecord({ learned: { clientId: 'x' } })) === '{}' && JSON.stringify(contract.decodeNousClientRecord([])) === '{}')
  check('the traffic-off switch skips the read', await (async () => { process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'; const r = await contract.peekNousClient({ now, force: true }); delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC; return r.kind === 'skipped' && r.why === 'traffic-off' })())
  check('the record on disk never carries a token or a key', !/rt-fixture|sk-nous|access/i.test(readFileSync(contract.nousClientContractPath(), 'utf8')))
} finally {
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(failures === 0 ? `\nNOUS CLIENT CONTRACT GREEN (${passes} checks; loopback fixture, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
