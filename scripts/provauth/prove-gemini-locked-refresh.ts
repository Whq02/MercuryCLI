#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rotatingTokenServer } from './lib/rotating-token-server.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = join(proofHome, 'home')
mkdirSync(home)
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET']) delete process.env[name]
const server = rotatingTokenServer('')
server.rotates = false
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = `${server.base}/token`
const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const accounts = await import('../../src/models/roads/gemini/geminiAccounts.ts')
const contract = await import('../../src/models/roads/gemini/antigravityClientContract.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/models/roads/accountSlots.ts')
const logins = await import('../../src/screen/boot-face/logins/facts.ts')

const fixHint = 'fix currentGeminiPlanTokens or currentGeminiTokens in src/models/roads/gemini/geminiAccounts.ts (the roads they hand the door), the Google rows in src/models/roads/account-slots/gemini.ts, or the door in src/models/sign-in/lifecycle/lockedRefresh.ts; the stand-in token server is scripts/provauth/lib/rotating-token-server.ts'
let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : `${detail ? ` — ${detail}` : ''} — ${fixHint}`}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function within(ms: number, holds: () => boolean): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!holds()) {
    if (Date.now() > deadline) return false
    await sleep(10)
  }
  return true
}
async function until(what: string, holds: () => boolean): Promise<void> {
  if (!(await within(30_000, holds))) throw new Error(`timed out waiting until ${what} — ${fixHint}`)
}

const authPath = accounts.geminiAuthPathForDisplay()
const PLAN_REFRESH = '1//plan-refresh-fixture'
const OAUTH_REFRESH = '1//oauth-refresh-fixture'
const EMAIL = 'plan@example.invalid'
const CLIENT = 'client-fixture.apps.googleusercontent.com'
const EXPIRED_NOTE = 'sign-in expired — /logins gemini signs in again'
type Pair = { accessToken: string; refreshToken: string; accessTokenExpiresAtMs?: number }
type Stored = { client?: { clientId?: string }; preferredSource?: string; padding?: string; tokens?: Pair; plan?: { tokens: Pair; projectId?: string; email?: string } }
function seed(padding = '', validForMs = -60_000): void {
  const expired = Date.now() + validForMs
  writeFileSync(authPath, JSON.stringify({
    version: 1,
    client: { clientId: CLIENT },
    preferredSource: 'plan',
    ...(padding ? { padding } : {}),
    tokens: { accessToken: 'ya29.oauth-old', refreshToken: OAUTH_REFRESH, accessTokenExpiresAtMs: expired },
    plan: { tokens: { accessToken: 'ya29.plan-old', refreshToken: PLAN_REFRESH, accessTokenExpiresAtMs: expired }, projectId: 'project-fixture-123', email: EMAIL },
  }) + '\n', { mode: 0o600 })
}
const file = (): Stored => JSON.parse(readFileSync(authPath, 'utf8')) as Stored
const slot = (id: string) => deriveFamilySlotGroups().flatMap(group => group.slots).find(s => s.id === id)

type ChildEnd = { before?: string; access?: string; refresh?: string; stored?: string }
function child(signIn: 'plan' | 'oauth', onAbout: () => void = () => {}): Promise<ChildEnd> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['run', join(import.meta.dir, 'lib', 'gemini-refresh-child.ts'), signIn], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', chunk => {
      out += String(chunk)
      if (out.includes('"about":"refresh"')) onAbout()
    })
    proc.stderr.on('data', chunk => { err += String(chunk) })
    const overdue = setTimeout(() => proc.kill('SIGKILL'), 60_000)
    proc.on('close', code => {
      clearTimeout(overdue)
      try {
        resolve(JSON.parse(out.trim().split('\n').at(-1) ?? '') as ChildEnd)
      } catch {
        reject(new Error(`the child ended rc=${code}: ${out.slice(-400)} ${err.slice(-400)}`))
      }
    })
  })
}

async function twoProcessesOneSignIn(signIn: 'plan' | 'oauth', refreshToken: string, storedAccess: () => string | undefined): Promise<void> {
  seed()
  const before = server.grants.length
  const release = server.hold()
  const first = child(signIn)
  await until('the first process has its grant at the server', () => server.grants.length === before + 1)
  let secondAsked = false
  const second = child(signIn, () => { secondAsked = true })
  await until('the second process has read the pair and asked to refresh it', () => secondAsked)
  await sleep(1_500)
  check(`${signIn}: while the first process exchanges, the second sends nothing`, server.grants.length === before + 1, `${server.grants.length - before} grants`)
  release()
  const [a, b] = await Promise.all([first, second])
  check(`${signIn}: exactly one exchange reached the server`, server.grants.length === before + 1, `${server.grants.length - before} grants`)
  check(`${signIn}: both processes end with the one new access token, the stored one, on the refresh token that does not rotate`, a.access !== undefined && a.access === b.access && a.access !== a.before && storedAccess() === a.access && a.refresh === refreshToken && b.refresh === refreshToken, JSON.stringify({ a, b, stored: storedAccess() }))
}

try {
  check('the proof writes under its own scratch home', authPath.startsWith(home), authPath)

  console.log('── two Mercury processes, one Google sign-in: one grant reaches the server (the plan sign-in, then the bring-your-own one) ──')
  await twoProcessesOneSignIn('plan', PLAN_REFRESH, () => file().plan?.tokens.accessToken)
  const planGrant = server.grants.at(-1)
  check('the plan grant on the wire is the one 1.1.0 sent: the address, the four form fields under Google\'s Antigravity client, the headers', planGrant?.path === '/token' && Object.keys(planGrant.form).sort().join(',') === 'client_id,client_secret,grant_type,refresh_token' && planGrant.form.client_id === contract.ANTIGRAVITY_OAUTH_CLIENT_ID && planGrant.form.client_secret === contract.ANTIGRAVITY_OAUTH_CLIENT_SECRET && planGrant.form.refresh_token === PLAN_REFRESH && planGrant.headers['content-type'] === 'application/x-www-form-urlencoded' && /^mercury\//.test(planGrant.headers['user-agent'] ?? ''), JSON.stringify({ path: planGrant?.path, form: Object.keys(planGrant?.form ?? {}), agent: planGrant?.headers['user-agent'] }))
  await twoProcessesOneSignIn('oauth', OAUTH_REFRESH, () => file().tokens?.accessToken)
  const oauthGrant = server.grants.at(-1)
  check('the bring-your-own grant on the wire is the one 1.1.0 sent: the address, the three form fields under the stored client, the headers', oauthGrant?.path === '/token' && Object.keys(oauthGrant.form).sort().join(',') === 'client_id,grant_type,refresh_token' && oauthGrant.form.client_id === CLIENT && oauthGrant.form.refresh_token === OAUTH_REFRESH && oauthGrant.headers['content-type'] === 'application/x-www-form-urlencoded' && /^mercury\//.test(oauthGrant.headers['user-agent'] ?? ''), JSON.stringify({ path: oauthGrant?.path, form: Object.keys(oauthGrant?.form ?? {}), agent: oauthGrant?.headers['user-agent'] }))
  check('no lock is left beside the store', !existsSync(`${authPath}.lock`))

  console.log('── one process refreshes the plan sign-in while another refreshes the bring-your-own one: neither write loses the other\'s field ──')
  const padding = 'x'.repeat(6_000_000)
  seed(padding)
  let before = server.grants.length
  const release = server.hold()
  const plan = child('plan')
  const oauth = child('oauth')
  await within(3_000, () => server.grants.length === before + 2)
  release()
  const [planEnd, oauthEnd] = await Promise.all([plan, oauth])
  const both = file()
  check('each process got a new access token of its own', planEnd.access !== undefined && oauthEnd.access !== undefined && planEnd.access !== 'ya29.plan-old' && oauthEnd.access !== 'ya29.oauth-old', JSON.stringify({ plan: planEnd.access, oauth: oauthEnd.access }))
  check('the store holds BOTH new access tokens', both.plan?.tokens.accessToken === planEnd.access && both.tokens?.accessToken === oauthEnd.access, JSON.stringify({ planStored: both.plan?.tokens.accessToken, planGot: planEnd.access, oauthStored: both.tokens?.accessToken, oauthGot: oauthEnd.access }))
  check('and every field neither refresh owns: the client, the preferred source, the plan\'s project and e-mail, the unknown key', both.client?.clientId === CLIENT && both.preferredSource === 'plan' && both.plan?.projectId === 'project-fixture-123' && both.plan.email === EMAIL && both.padding === padding, JSON.stringify({ client: both.client, preferredSource: both.preferredSource, project: both.plan?.projectId, email: both.plan?.email, padding: both.padding?.length }))

  console.log('── a passing failure changes nothing on disk ──')
  seed()
  before = server.grants.length
  const bytes = readFileSync(authPath, 'utf8')
  server.status = 503
  const stalePlan = await accounts.currentGeminiPlanTokens()
  const staleOauth = await accounts.currentGeminiTokens()
  server.status = 200
  check('a 503 answers the stored tokens of each sign-in after one grant each and leaves the store byte for byte', stalePlan?.accessToken === 'ya29.plan-old' && staleOauth?.accessToken === 'ya29.oauth-old' && server.grants.length === before + 2 && readFileSync(authPath, 'utf8') === bytes && slot('gemini:plan')?.signedIn === true && slot('gemini:oauth')?.signedIn === true, JSON.stringify({ plan: stalePlan?.accessToken, oauth: staleOauth?.accessToken, grants: server.grants.length - before }))
  const recovered = await accounts.currentGeminiPlanTokens()
  check('the next call refreshes', recovered !== undefined && recovered.accessToken !== 'ya29.plan-old' && file().plan?.tokens.accessToken === recovered.accessToken)

  console.log('── a forced refresh whose write fails: the next ordinary call answers the new token, not the one on disk ──')
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    console.log('[SKIP] not staged on Windows or as root: chmod 0o500 does not stop a write into the home there')
  } else {
    seed('', 3_600_000)
    before = server.grants.length
    const releaseForced = server.hold()
    const forcedCall = accounts.currentGeminiTokens({ force: true })
    await until('the forced grant is at the server', () => server.grants.length === before + 1)
    chmodSync(home, 0o500)
    releaseForced()
    const renewed = await forcedCall
    chmodSync(home, 0o700)
    check('the forced call answers a new access token though the store refused the write and still holds one that reads fresh', renewed !== undefined && renewed.accessToken !== 'ya29.oauth-old' && file().tokens?.accessToken === 'ya29.oauth-old', JSON.stringify({ answered: renewed?.accessToken, stored: file().tokens?.accessToken }))
    const ordinary = await accounts.currentGeminiTokens()
    check('the next ordinary call answers the new token, sends nothing, and lands it in the store', ordinary?.accessToken === renewed?.accessToken && server.grants.length === before + 1 && file().tokens?.accessToken === renewed?.accessToken, JSON.stringify({ answered: ordinary?.accessToken, stored: file().tokens?.accessToken, grants: server.grants.length - before }))
  }

  console.log('── a dead grant keeps the row: /accounts shows the sign-in as expired, like the other roads ──')
  seed()
  server.revoked.add(PLAN_REFRESH)
  before = server.grants.length
  const deadPlan = await accounts.currentGeminiPlanTokens()
  check('the plan sign-in: invalid_grant answers no tokens after one grant', deadPlan === undefined && server.grants.length === before + 1, `${server.grants.length - before} grants`)
  check('the plan block stands with its project and e-mail, the refresh token blank', file().plan?.email === EMAIL && file().plan?.projectId === 'project-fixture-123' && file().plan?.tokens.refreshToken === '' && file().plan?.tokens.accessToken === 'ya29.plan-old', JSON.stringify(file().plan))
  check('every other reader sees what it saw after 1.1.0 dropped the block: not connected, no facts, the next source active', accounts.geminiPlanConnected() === false && accounts.geminiPlanFacts() === undefined && accounts.resolveGeminiAccount()?.kind === 'oauth', JSON.stringify(accounts.resolveGeminiAccount()))
  const planRow = slot('gemini:plan')
  check('/accounts keeps the Google sign-in row, not signed in, not active, with its e-mail and the expired words', planRow?.signedIn === false && planRow.active === false && planRow.identity.includes(EMAIL) && planRow.signInEmail === EMAIL && planRow.stateNote === EXPIRED_NOTE && planRow.removal.route === 'gemini-plan', JSON.stringify(planRow))
  const planAgain = await accounts.currentGeminiPlanTokens()
  check('the dead grant is not sent again', planAgain === undefined && server.grants.length === before + 1, `${server.grants.length - before} grants`)
  server.revoked.add(OAUTH_REFRESH)
  before = server.grants.length
  const deadOauth = await accounts.currentGeminiTokens()
  check('the bring-your-own sign-in: invalid_grant answers no tokens after one grant', deadOauth === undefined && server.grants.length === before + 1, `${server.grants.length - before} grants`)
  check('its tokens stand with the refresh token blank, and the client config stands', file().tokens?.refreshToken === '' && file().tokens?.accessToken === 'ya29.oauth-old' && file().client?.clientId === CLIENT && accounts.geminiOauthConnected() === false, JSON.stringify({ tokens: file().tokens, client: file().client }))
  const oauthRow = slot('gemini:oauth')
  check('/accounts keeps the Google account row, not signed in, not active, with the expired words', oauthRow?.signedIn === false && oauthRow.active === false && oauthRow.identity === 'Google account (OAuth)' && oauthRow.stateNote === EXPIRED_NOTE && oauthRow.removal.route === 'gemini-oauth', JSON.stringify(oauthRow))
  check('with both expired no Google source is active and a request resolves to none', accounts.resolveGeminiAccount() === undefined && (await accounts.resolveGeminiRequestAuth()) === undefined)
  check('both rows carry the mark every expired sign-in row carries', planRow?.expired === true && oauthRow?.expired === true && slot('gemini:plan')?.expired === true, JSON.stringify({ plan: planRow?.expired, oauth: oauthRow?.expired }))
  const face = logins.collectLoginsScreenFacts()
  const googleArm = logins.loginsCatalogue().find(arm => arm.familyId === 'gemini')
  const faceRow = googleArm ? logins.loginsRowStateOf(googleArm, face) : undefined
  check('the Boot face says it as it does for an expired Anthropic sign-in: the Logins glance, the row loud with its identity and the word expired, the family not counted as signed in', logins.loginsGlance(face.groups) === 'Gemini sign-in expired — sign in again' && faceRow?.chip === `Google sign-in (tier unknown) ${EMAIL} · expired` && faceRow.loud === true && faceRow.signedIn === false && logins.loginsFamilyCounts(face.groups).signed === 0, JSON.stringify({ glance: logins.loginsGlance(face.groups), row: faceRow, signed: logins.loginsFamilyCounts(face.groups).signed }))
  const removedPlan = planRow ? executeSlotRemoval(planRow) : undefined
  const removedOauth = oauthRow ? executeSlotRemoval(oauthRow) : undefined
  check('removing each expired row takes it off the list and out of the store', removedPlan?.mutated === true && removedOauth?.mutated === true && slot('gemini:plan') === undefined && slot('gemini:oauth') === undefined && file().plan === undefined && file().tokens === undefined && file().client?.clientId === CLIENT, JSON.stringify({ removedPlan, removedOauth, left: Object.keys(file()) }))
} finally {
  server.stop()
}
console.log(failures === 0 ? `\nGEMINI LOCKED REFRESH GREEN (${passes} checks; two real processes, a loopback token server, no live host)` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
